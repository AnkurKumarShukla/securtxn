// On-chain KYC, against the ATS security contract.
//
// This is where the platform's verification becomes something the token itself
// enforces. A transfer to an account that was never granted KYC is rejected by
// the contract, not by our API — which is the difference between a compliance
// control and a badge (D40).
//
// The SDK cannot do this: it is browser-only, with no headless signer (D42). So
// the call goes straight to the contract ABI with viem, which is also the right
// shape — granting is continuous and automatic, driven by wallet confirmation
// rather than by a human at a browser.
//
// Spec: docs/architecture.md §4.5

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAddressResolver, hederaChain, type AddressResolver } from "./hedera.js";

/**
 * Verified against `IKyc.json` in @hashgraph/asset-tokenization-contracts 8.0.0.
 * Only the four functions this platform needs — a partial ABI is enough for
 * viem, and a trimmed one is easier to audit than a copied full artifact.
 */
export const KYC_ABI = [
  {
    type: "function",
    name: "grantKyc",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "vcId", type: "string" },
      { name: "validFrom", type: "uint256" },
      { name: "validTo", type: "uint256" },
      { name: "issuer", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "revokeKyc",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getKycStatusFor",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "isInternalKycActivated",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

/** ATS returns KYC status as a uint8. 0 = not granted, 1 = granted. */
export const KYC_STATUS = { NOT_GRANTED: 0, GRANTED: 1 } as const;

/**
 * How "no expiry" is expressed on chain.
 *
 * NOT zero: the contract rejects `validTo = 0` with `InvalidDates()`. A far
 * future date is the only way to say "does not expire", so a credential with
 * no `aadhaarKycTtl` gets a century rather than a value the contract refuses.
 */
export const NO_EXPIRY_SECONDS = 100n * 365n * 24n * 60n * 60n;

export type GrantKycInput = {
  /** The deployed security: Hedera id or EVM address. */
  securityId: string;
  /** The payee wallet being granted. */
  account: string;
  /** Off-chain credential id. The chain stores a reference, never the body. */
  vcId: string;
  validFrom: Date;
  /**
   * Null means no expiry. Encoded on chain as a far-future date, never 0 —
   * the contract rejects zero with `InvalidDates()`.
   */
  validTo: Date | null;
};

export type ComplianceResult = {
  txHash: string;
  /** False for the mock: nothing was broadcast. */
  broadcast: boolean;
};

export interface ComplianceGateway {
  readonly kind: "ats" | "mock";
  grantKyc(input: GrantKycInput): Promise<ComplianceResult>;
  revokeKyc(input: { securityId: string; account: string }): Promise<ComplianceResult>;
  getKycStatus(input: { securityId: string; account: string }): Promise<number>;
  /** The issuer address recorded on chain; must match the credential signer. */
  issuerAddress(): Address;
}

export type AtsGatewayOptions = {
  chainId: number;
  rpcUrl: string;
  mirrorNodeUrl: string;
  issuerPrivateKey: string;
  /**
   * Hedera's relay does not always estimate gas usefully for diamond proxies,
   * so a floor is configurable rather than assumed.
   */
  gasLimit?: bigint;
};

export class AtsComplianceGateway implements ComplianceGateway {
  readonly kind = "ats" as const;

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly resolver: AddressResolver;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly options: AtsGatewayOptions) {
    const chain = hederaChain(options.chainId, options.rpcUrl);
    this.account = privateKeyToAccount(options.issuerPrivateKey as Hex);
    this.publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
    this.walletClient = createWalletClient({
      chain,
      transport: http(options.rpcUrl),
      account: this.account,
    });
    this.resolver = createAddressResolver(options.mirrorNodeUrl);
  }

  issuerAddress(): Address {
    return this.account.address;
  }

  async grantKyc(input: GrantKycInput): Promise<ComplianceResult> {
    const [security, account] = await Promise.all([
      this.resolver.toEvmAddress(input.securityId),
      this.resolver.toEvmAddress(input.account),
    ]);

    const validFrom = BigInt(Math.floor(input.validFrom.getTime() / 1000));

    const txHash = await this.walletClient.writeContract({
      address: security,
      abi: KYC_ABI,
      functionName: "grantKyc",
      args: [
        account,
        input.vcId,
        validFrom,
        // A far-future date, never 0 — the contract rejects zero as InvalidDates.
        input.validTo ? BigInt(Math.floor(input.validTo.getTime() / 1000)) : validFrom + NO_EXPIRY_SECONDS,
        this.account.address,
      ],
      chain: this.walletClient.chain,
      account: this.account,
      ...(this.options.gasLimit ? { gas: this.options.gasLimit } : {}),
    });

    // Wait for inclusion: reporting a grant the network later rejects would
    // leave the platform believing a wallet is transferable when it is not.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`grantKyc reverted on chain (tx ${txHash})`);
    }

    return { txHash, broadcast: true };
  }

  async revokeKyc(input: { securityId: string; account: string }): Promise<ComplianceResult> {
    const [security, account] = await Promise.all([
      this.resolver.toEvmAddress(input.securityId),
      this.resolver.toEvmAddress(input.account),
    ]);

    const txHash = await this.walletClient.writeContract({
      address: security,
      abi: KYC_ABI,
      functionName: "revokeKyc",
      args: [account],
      chain: this.walletClient.chain,
      account: this.account,
      ...(this.options.gasLimit ? { gas: this.options.gasLimit } : {}),
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`revokeKyc reverted on chain (tx ${txHash})`);
    }

    return { txHash, broadcast: true };
  }

  async getKycStatus(input: { securityId: string; account: string }): Promise<number> {
    const [security, account] = await Promise.all([
      this.resolver.toEvmAddress(input.securityId),
      this.resolver.toEvmAddress(input.account),
    ]);

    return Number(
      await this.publicClient.readContract({
        address: security,
        abi: KYC_ABI,
        functionName: "getKycStatusFor",
        args: [account],
      }),
    );
  }
}

/**
 * In-memory gateway for tests and for running without a deployed security.
 *
 * A named implementation behind the real interface, never a silent no-op: it
 * reports `broadcast: false` so a caller can never present its result as an
 * on-chain grant (D21, D32).
 */
export class MockComplianceGateway implements ComplianceGateway {
  readonly kind = "mock" as const;
  private readonly granted = new Map<string, { vcId: string; validTo: Date | null }>();
  readonly calls: { method: string; account: string }[] = [];

  constructor(private readonly issuer: Address = "0x0000000000000000000000000000000000000001") {}

  issuerAddress(): Address {
    return this.issuer;
  }

  async grantKyc(input: GrantKycInput): Promise<ComplianceResult> {
    this.calls.push({ method: "grantKyc", account: input.account });
    this.granted.set(key(input.securityId, input.account), {
      vcId: input.vcId,
      validTo: input.validTo,
    });
    return { txHash: `0xmock${Buffer.from(input.vcId).toString("hex").slice(0, 56)}`, broadcast: false };
  }

  async revokeKyc(input: { securityId: string; account: string }): Promise<ComplianceResult> {
    this.calls.push({ method: "revokeKyc", account: input.account });
    this.granted.delete(key(input.securityId, input.account));
    return { txHash: "0xmockrevoke", broadcast: false };
  }

  async getKycStatus(input: { securityId: string; account: string }): Promise<number> {
    const record = this.granted.get(key(input.securityId, input.account));
    if (!record) return KYC_STATUS.NOT_GRANTED;
    // Expiry is enforced here too, so the mock behaves like the contract rather
    // than like an allowlist that never lapses.
    if (record.validTo && record.validTo.getTime() <= Date.now()) return KYC_STATUS.NOT_GRANTED;
    return KYC_STATUS.GRANTED;
  }
}

function key(securityId: string, account: string): string {
  return `${securityId.toLowerCase()}|${account.toLowerCase()}`;
}
