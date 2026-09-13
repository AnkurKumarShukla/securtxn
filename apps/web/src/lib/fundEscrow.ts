"use client";

// Funding an escrow from the payer's own wallet.
//
// THE PLATFORM CANNOT DO THIS, and that is the point. The escrow contract
// records `msg.sender` as the payer and refunds to that address once the
// timelock passes, so the party who locks is the party the money returns to.
// Locking from a platform-held treasury would make the platform the payer in
// the contract's eyes, which is exactly the custody this flow exists to remove.
//
// WHAT THE PLATFORM STILL DECIDES. Every parameter below comes from the API's
// prepared lock and none of it may be edited here. The secret that releases the
// escrow is generated server-side and never leaves it — a payer who knew it
// could drain their own escrow the moment they funded it — and the lock id the
// contract derives is checked against the one the API recorded, so altering the
// payee, the amount or the timelock produces a lock the API refuses to
// acknowledge and that this payment will never be marked as settled against.
//
// Two transactions, both approved by the person in MetaMask:
//   1. approve   let the escrow contract pull exactly this amount
//   2. lock      it pulls, and the money is held against the hashlock
//
// Spec: docs/architecture.md §4.5 (D41)

import { createPublicClient, http, keccak256, toHex, type Hex } from "viem";
import type { PreparedLock } from "@cp/shared-types";
import { RPC_URL, hederaTestnet } from "./chain";
import type { PayeeSigner } from "./wallet";
import { api, messageOf } from "./flow";

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
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
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const HTLC_ABI = [
  {
    type: "function",
    name: "lock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentRef", type: "bytes32" },
      { name: "payee", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "hashlock", type: "bytes32" },
      { name: "timelock", type: "uint64" },
    ],
    outputs: [{ name: "lockId", type: "bytes32" }],
  },
] as const;

export type FundProgress = (line: string) => void;

export async function fundEscrow(input: {
  paymentId: string;
  prepared: PreparedLock;
  signer: PayeeSigner;
  token: string;
  report: FundProgress;
}): Promise<{ lockTxHash: string }> {
  const { paymentId, prepared, signer, token: authToken, report } = input;
  const { address, client } = signer;

  // The contract uses msg.sender as the payer, and the API computed the lock id
  // against the address it has on file. A different connected account produces
  // a different lock id and an escrow nobody can reconcile — so this is checked
  // before anything is signed rather than discovered after money has moved.
  if (address.toLowerCase() !== prepared.payerAddress.toLowerCase()) {
    throw new Error(
      `This payment is authorised to be funded from ${prepared.payerAddress}, but your wallet is on ${address}. Switch accounts in MetaMask.`,
    );
  }

  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) });
  const amount = BigInt(prepared.onChainAmount);

  // Read first. An insufficient balance reverts on chain, which costs gas and
  // arrives as an opaque "transfer reverted" — a read is free and names the
  // actual problem while the person can still do something about it.
  const held = (await publicClient.readContract({
    address: prepared.tokenAddress as Hex,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  if (held < amount) {
    throw new Error(
      `Your wallet holds ${held} base units of this token but the payment needs ${prepared.onChainAmount}. Top up ${address} before funding.`,
    );
  }

  // Skip the approval if a sufficient one already stands. Re-approving is not
  // harmful, but it is a second wallet prompt for nothing, and people learn to
  // click through prompts that turn out not to matter.
  const allowance = (await publicClient.readContract({
    address: prepared.tokenAddress as Hex,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [address, prepared.escrowAddress as Hex],
  })) as bigint;

  if (allowance < amount) {
    report("approve the escrow in MetaMask…");
    const approveTx = await client.writeContract({
      account: address,
      chain: hederaTestnet,
      address: prepared.tokenAddress as Hex,
      abi: ERC20_ABI,
      functionName: "approve",
      // Exactly this amount, never unlimited. An unlimited allowance left
      // standing lets the contract move the rest of the balance later.
      args: [prepared.escrowAddress as Hex, amount],
      gas: 1_000_000n,
    });
    const approved = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (approved.status !== "success") throw new Error(`approval reverted (tx ${approveTx})`);
    report("approval confirmed");
  }

  report("confirm the lock in MetaMask…");
  const lockTxHash = await client.writeContract({
    account: address,
    chain: hederaTestnet,
    address: prepared.escrowAddress as Hex,
    abi: HTLC_ABI,
    functionName: "lock",
    args: [
      prepared.paymentRef as Hex,
      prepared.payeeAddress as Hex,
      prepared.tokenAddress as Hex,
      amount,
      prepared.hashlock as Hex,
      BigInt(prepared.timelockSeconds),
    ],
    gas: 1_500_000n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: lockTxHash });
  if (receipt.status !== "success") throw new Error(`lock reverted (tx ${lockTxHash})`);

  // Report it last. The transaction above is what moved the money; this only
  // tells the platform where to find it, and the API recomputes the lock id
  // from these values before believing any of it.
  report("recording the escrow…");
  const recorded = await api(`/payments/${paymentId}/settlement/lock`, {
    method: "POST",
    token: authToken,
    body: {
      escrowAddress: prepared.escrowAddress,
      lockId: prepared.lockId,
      hashlock: prepared.hashlock,
      timelock: prepared.timelock,
      payerAddress: prepared.payerAddress,
      tokenAddress: prepared.tokenAddress,
      amount: prepared.amount,
      onChainAmount: prepared.onChainAmount,
      lockTxHash,
    },
  });
  if (!recorded.ok) throw new Error(`record lock → ${messageOf(recorded.body)}`);

  return { lockTxHash };
}

/**
 * The contract's reference for a payment.
 *
 * Derived here rather than imported from `@cp/contracts`, which is a Hardhat
 * workspace: pulling it into the browser bundle to reach one keccak would bring
 * the solidity toolchain with it. Kept identical to `paymentRefFor` there — the
 * payment id itself never goes on chain, because a public ledger is forever and
 * carries hashes only (design principle 2).
 */
export function paymentRefFor(paymentRequestId: string): Hex {
  return keccak256(toHex(paymentRequestId));
}

/**
 * Rebuilds the instruction from the settlement row.
 *
 * Needed because the prepared lock is the RESPONSE to authorising, and a reload
 * between authorising and funding would otherwise strand the payment: the
 * escrow is recorded as PENDING_LOCK and nothing on the page could complete it.
 * Every field is already stored except the payment reference, which is a pure
 * derivation, and the timelock in seconds, which is the same instant the row
 * already holds.
 */
export function preparedFromSettlement(
  paymentId: string,
  row: {
    escrowAddress: string;
    lockId: string;
    hashlock: string;
    timelock: string;
    payerAddress: string;
    payeeAddress: string;
    tokenAddress: string;
    amount: string;
    onChainAmount: string;
  },
): PreparedLock {
  return {
    escrowAddress: row.escrowAddress,
    lockId: row.lockId,
    paymentRef: paymentRefFor(paymentId),
    payerAddress: row.payerAddress,
    payeeAddress: row.payeeAddress,
    tokenAddress: row.tokenAddress,
    amount: row.amount,
    onChainAmount: row.onChainAmount,
    hashlock: row.hashlock,
    timelock: row.timelock,
    timelockSeconds: Math.floor(new Date(row.timelock).getTime() / 1000),
  };
}
