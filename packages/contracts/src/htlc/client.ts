// Client for the PaymentHtlc escrow.
//
// The hashing helpers here are the off-chain half of a contract that verifies
// on-chain, so each one has a Solidity counterpart it must agree with byte for
// byte. `computeLockId` in particular re-derives what the contract derives —
// tested against the deployed contract's own pure function rather than trusted
// (test/htlc.test.ts), because a client that predicts the wrong id records the
// wrong lock against the payment and then cannot find the money.
//
// Spec: docs/architecture.md 4.5

import { randomBytes } from "node:crypto";
import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PAYMENT_HTLC_ABI, PAYMENT_HTLC_BYTECODE } from "./artifact.js";

/** Mirrors the contract's Status enum; the index is the on-chain value. */
export const LOCK_STATUS = ["NONE", "LOCKED", "CLAIMED", "REFUNDED"] as const;
export type LockStatus = (typeof LOCK_STATUS)[number];

export type LockView = {
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  hashlock: Hex;
  timelock: bigint;
  status: LockStatus;
  /** Zero until claimed. Non-zero IS the receipt — the payee published it. */
  preimage: Hex;
  paymentRef: Hex;
};

/**
 * A fresh 32-byte secret.
 *
 * Must come from a CSPRNG. A guessable preimage lets anyone but the payee claim
 * the escrow, which would break both the payment and the receipt it exists to
 * produce.
 */
export function newPreimage(): Hex {
  return toHex(randomBytes(32));
}

/** keccak256 over the raw 32 bytes — matches `keccak256(abi.encodePacked(preimage))`. */
export function hashlockFor(preimage: Hex): Hex {
  return keccak256(preimage);
}

/**
 * Commitment to a payment request id.
 *
 * The id itself never goes on chain. This is the same reasoning as every other
 * commitment in the system: a public ledger is forever, so it carries hashes
 * and nothing else (design principle 2).
 */
export function paymentRefFor(paymentRequestId: string): Hex {
  return keccak256(toHex(paymentRequestId));
}

export type LockParams = {
  paymentRef: Hex;
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  hashlock: Hex;
  /** Unix seconds. Must be in the future at the moment the lock is mined. */
  timelock: bigint;
};

/** The TypeScript twin of `PaymentHtlc.computeLockId`. */
export function computeLockId(params: LockParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        params.paymentRef,
        params.payer,
        params.payee,
        params.token,
        params.amount,
        params.hashlock,
        params.timelock,
      ],
    ),
  );
}

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export type HtlcClientOptions = {
  address: Address;
  publicClient: PublicClient;
  /**
   * Hedera's relay does not reliably estimate gas for contract calls, so every
   * write here passes an explicit limit rather than letting viem guess.
   */
  gas?: bigint;
};

export class HtlcClient {
  private readonly gas: bigint;

  constructor(private readonly options: HtlcClientOptions) {
    this.gas = options.gas ?? 1_000_000n;
  }

  get address(): Address {
    return this.options.address;
  }

  /**
   * Approves the escrow to pull `amount`, then locks it.
   *
   * Two transactions, not one: ERC-20 has no pull-with-signature, and batching
   * them would only hide that the first can succeed while the second reverts.
   * Returns both hashes so the caller can record what actually happened.
   */
  async lock(
    wallet: WalletClient,
    params: LockParams,
  ): Promise<{ lockId: Hex; approveTxHash: Hex; lockTxHash: Hex }> {
    const account = wallet.account;
    if (!account) throw new Error("lock requires a wallet client with an account");

    const approveTxHash = await wallet.writeContract({
      address: params.token,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [this.options.address, params.amount],
      chain: wallet.chain ?? null,
      account,
      gas: this.gas,
    });
    await this.confirm(approveTxHash, "approve");

    const lockTxHash = await wallet.writeContract({
      address: this.options.address,
      abi: PAYMENT_HTLC_ABI,
      functionName: "lock",
      args: [
        params.paymentRef,
        params.payee,
        params.token,
        params.amount,
        params.hashlock,
        params.timelock,
      ],
      chain: wallet.chain ?? null,
      account,
      gas: this.gas,
    });
    await this.confirm(lockTxHash, "lock");

    return { lockId: computeLockId(params), approveTxHash, lockTxHash };
  }

  /** Claims an escrow. Must be sent by the payee — that is what makes it a receipt. */
  async claim(wallet: WalletClient, lockId: Hex, preimage: Hex): Promise<Hex> {
    const account = wallet.account;
    if (!account) throw new Error("claim requires a wallet client with an account");

    const hash = await wallet.writeContract({
      address: this.options.address,
      abi: PAYMENT_HTLC_ABI,
      functionName: "claim",
      args: [lockId, preimage],
      chain: wallet.chain ?? null,
      account,
      gas: this.gas,
    });
    await this.confirm(hash, "claim");
    return hash;
  }

  /** Returns an expired escrow to the payer. Any account may send it. */
  async refund(wallet: WalletClient, lockId: Hex): Promise<Hex> {
    const account = wallet.account;
    if (!account) throw new Error("refund requires a wallet client with an account");

    const hash = await wallet.writeContract({
      address: this.options.address,
      abi: PAYMENT_HTLC_ABI,
      functionName: "refund",
      args: [lockId],
      chain: wallet.chain ?? null,
      account,
      gas: this.gas,
    });
    await this.confirm(hash, "refund");
    return hash;
  }

  async getLock(lockId: Hex): Promise<LockView> {
    const raw = await this.options.publicClient.readContract({
      address: this.options.address,
      abi: PAYMENT_HTLC_ABI,
      functionName: "getLock",
      args: [lockId],
    });

    return {
      payer: raw.payer,
      payee: raw.payee,
      token: raw.token,
      amount: raw.amount,
      hashlock: raw.hashlock,
      timelock: BigInt(raw.timelock),
      status: LOCK_STATUS[raw.status] ?? "NONE",
      preimage: raw.preimage,
      paymentRef: raw.paymentRef,
    };
  }

  private async confirm(hash: Hex, label: string): Promise<void> {
    const receipt = await this.options.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  }
}

/** Deploys a fresh escrow. No constructor arguments — it holds no configuration. */
export async function deployPaymentHtlc(input: {
  wallet: WalletClient;
  publicClient: PublicClient;
  gas?: bigint;
}): Promise<{ address: Address; txHash: Hex }> {
  const account = input.wallet.account;
  if (!account) throw new Error("deploy requires a wallet client with an account");

  const txHash = await input.wallet.deployContract({
    abi: PAYMENT_HTLC_ABI,
    bytecode: PAYMENT_HTLC_BYTECODE,
    chain: input.wallet.chain ?? null,
    account,
    gas: input.gas ?? 3_000_000n,
  });

  const receipt = await input.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`deployment reverted (${txHash})`);
  }

  return { address: receipt.contractAddress, txHash };
}
