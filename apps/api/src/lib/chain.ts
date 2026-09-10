// The chain gateway: every write this API makes to Hedera, behind one seam.
//
// THIS IS A CHANGE OF POSTURE, and it should be read as one. Until now the API
// held no key that could move value: the approval bridge signed payouts, and
// the only server-side key issued KYC credentials, which cost gas and nothing
// else (D12, D32). A consumer UI cannot drive a terminal on someone's laptop,
// so issuance, minting, corporate actions and escrow operations have to be
// signed server-side.
//
// What survives from the old rule, and what does not:
//
//   SURVIVES  autonomous code still cannot approve a payout. /payments/:id/settle
//             requires an approver token, and no agent token reaches it.
//   SURVIVES  role separation is still structural — issuer, approver and agent
//             tokens verify against different secrets.
//   GONE      "the API process cannot move money". It can now. The honest
//             statement is that moving money requires an approver-scoped token
//             and leaves an evidence record, not that it is impossible here.
//
// TWO KEYS, ONE FALLBACK. The issuer key mints; the treasury key spends. They
// may be the same value in a demo, and when they are, the startup log says so
// rather than letting it pass as a deployment decision nobody made.
//
// MOCK IS NOT A NO-OP. It keeps balances in memory so a mint really does change
// what balanceOf reports, which is what makes a test of the mint route worth
// running. Its transaction hashes are marked, and `broadcasts` is false, so a
// synthetic hash can never be presented as an on-chain fact (D21).
//
// Spec: docs/architecture.md §4.5

import { randomBytes } from "node:crypto";
import {
  BondIssuer,
  DEFAULT_PARTITION,
  HtlcClient,
  SecurityLifecycle,
  computeLockId,
  createHederaClients,
  hashscanUrl,
  type CouponTerms,
  type LockParams,
} from "@cp/contracts";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { Config } from "../config/index.js";

export type IssueSecurityInput = {
  name: string;
  symbol: string;
  isin: string;
  decimals: number;
  currency: string;
  nominalValue: bigint;
  nominalValueDecimals: number;
  maxSupply: bigint;
  startingDate: Date;
  maturityDate: Date;
};

export type IssuedSecurity = {
  address: Address;
  txHash: string;
};

export type LockInput = {
  paymentRequestId: string;
  payee: Address;
  token: Address;
  amount: bigint;
  hashlock: Hex;
  timelock: Date;
};

export type LockOutput = {
  lockId: Hex;
  approveTxHash: string;
  lockTxHash: string;
  payer: Address;
};

export interface ChainGateway {
  readonly kind: "hedera" | "mock";
  /** False for the mock. Never report a mock hash as an on-chain transaction. */
  readonly broadcasts: boolean;
  readonly issuerAddress: Address;
  readonly treasuryAddress: Address;
  /** Null when nothing was broadcast, so a UI cannot link to a fiction. */
  explorerUrl(kind: "contract" | "transaction", id: string): string | null;

  issueSecurity(input: IssueSecurityInput): Promise<IssuedSecurity>;
  /** Registers the operator as a credential issuer the token trusts (D40). */
  prepareSecurity(security: Address): Promise<{ txHashes: string[]; alreadyPrepared: boolean }>;
  mint(security: Address, to: Address, baseUnits: bigint): Promise<string>;
  transfer(security: Address, to: Address, baseUnits: bigint): Promise<string>;
  setCoupon(security: Address, terms: CouponTerms): Promise<string>;
  updateMaturity(security: Address, maturity: Date): Promise<string>;
  redeem(security: Address, holder: Address, baseUnits: bigint): Promise<string>;

  decimals(security: Address): Promise<number>;
  balanceOf(security: Address, holder: Address): Promise<bigint>;
  totalSupply(security: Address): Promise<bigint>;
  /** Chain time, which is what every on-chain deadline is compared against. */
  chainTime(): Promise<Date>;

  lock(input: LockInput): Promise<LockOutput>;
  refund(lockId: Hex): Promise<string>;
}

/**
 * Resolves the gateway for this process.
 *
 * Real only when explicitly selected AND fully configured. Missing credentials
 * fall back to the mock rather than half-working, and the caller logs which one
 * it got.
 */
export function createChainGateway(config: Config): ChainGateway {
  const configured =
    config.CHAIN_GATEWAY === "hedera" &&
    config.ATS_ISSUER_PRIVATE_KEY &&
    config.HEDERA_JSON_RPC_URL &&
    config.HEDERA_MIRROR_NODE_URL &&
    config.ATS_FACTORY_ADDRESS &&
    config.ATS_RESOLVER_ADDRESS;

  if (!configured) return new MockChainGateway();

  return new HederaChainGateway(config);
}

export class HederaChainGateway implements ChainGateway {
  readonly kind = "hedera" as const;
  readonly broadcasts = true;

  private readonly issuerOps: SecurityLifecycle;
  private readonly treasuryOps: SecurityLifecycle;
  private readonly issuer: ReturnType<typeof createHederaClients>;
  private readonly treasury: ReturnType<typeof createHederaClients>;
  private readonly bondIssuer: BondIssuer;
  private readonly chainId: number;
  private readonly escrowAddress: Address | undefined;

  constructor(private readonly config: Config) {
    const base = {
      chainId: config.HEDERA_CHAIN_ID,
      rpcUrl: config.HEDERA_JSON_RPC_URL!,
      mirrorNodeUrl: config.HEDERA_MIRROR_NODE_URL!,
    };

    this.chainId = config.HEDERA_CHAIN_ID;
    this.issuer = createHederaClients({ ...base, privateKey: config.ATS_ISSUER_PRIVATE_KEY! });
    // Same key unless a treasury key is supplied. The container logs which,
    // because "the mint key also spends" is a deployment fact, not a detail.
    this.treasury = createHederaClients({
      ...base,
      privateKey: config.PLATFORM_TREASURY_PRIVATE_KEY ?? config.ATS_ISSUER_PRIVATE_KEY!,
    });

    this.issuerOps = new SecurityLifecycle(this.issuer);
    this.treasuryOps = new SecurityLifecycle(this.treasury);
    this.bondIssuer = new BondIssuer({
      ...base,
      factoryAddress: config.ATS_FACTORY_ADDRESS!,
      resolverAddress: config.ATS_RESOLVER_ADDRESS!,
      issuerPrivateKey: config.ATS_ISSUER_PRIVATE_KEY!,
      gasLimit: 12_000_000n,
    });
    this.escrowAddress = config.HTLC_CONTRACT_ADDRESS as Address | undefined;
  }

  get issuerAddress(): Address {
    return this.issuer.address;
  }

  get treasuryAddress(): Address {
    return this.treasury.address;
  }

  explorerUrl(kind: "contract" | "transaction", id: string): string {
    return hashscanUrl(this.chainId, kind, id);
  }

  async issueSecurity(input: IssueSecurityInput): Promise<IssuedSecurity> {
    const result = await this.bondIssuer.issue({
      name: input.name,
      symbol: input.symbol,
      isin: input.isin,
      decimals: input.decimals,
      currency: input.currency,
      nominalValue: input.nominalValue,
      nominalValueDecimals: input.nominalValueDecimals,
      maxSupply: input.maxSupply,
      startingDate: input.startingDate,
      maturityDate: input.maturityDate,
    });
    return { address: result.bondAddress, txHash: result.txHash };
  }

  async prepareSecurity(security: Address) {
    const result = await this.issuerOps.prepare(security);
    return {
      txHashes: result.txHashes as string[],
      alreadyPrepared: result.txHashes.length === 0,
    };
  }

  mint(security: Address, to: Address, baseUnits: bigint): Promise<string> {
    return this.issuerOps.mint(security, to, baseUnits);
  }

  transfer(security: Address, to: Address, baseUnits: bigint): Promise<string> {
    // Treasury, not issuer: this is spending, and the two authorities are held
    // separately wherever a deployment bothers to separate them.
    return this.treasuryOps.transfer(security, to, baseUnits);
  }

  setCoupon(security: Address, terms: CouponTerms): Promise<string> {
    return this.issuerOps.setCoupon(security, terms);
  }

  updateMaturity(security: Address, maturity: Date): Promise<string> {
    return this.issuerOps.updateMaturityDate(security, maturity);
  }

  redeem(security: Address, holder: Address, baseUnits: bigint): Promise<string> {
    return this.issuerOps.redeemAtMaturity(security, holder, DEFAULT_PARTITION, baseUnits);
  }

  decimals(security: Address): Promise<number> {
    return this.issuerOps.decimals(security);
  }

  balanceOf(security: Address, holder: Address): Promise<bigint> {
    return this.issuerOps.balanceOf(security, holder);
  }

  totalSupply(security: Address): Promise<bigint> {
    return this.issuerOps.totalSupply(security);
  }

  chainTime(): Promise<Date> {
    return this.issuerOps.chainTime();
  }

  async lock(input: LockInput): Promise<LockOutput> {
    const escrow = this.requireEscrow();
    const client = new HtlcClient({ address: escrow, publicClient: this.treasury.publicClient });

    const params: LockParams = {
      paymentRef: keccak256(toHex(input.paymentRequestId)),
      payer: this.treasury.address,
      payee: input.payee,
      token: input.token,
      amount: input.amount,
      hashlock: input.hashlock,
      timelock: BigInt(Math.floor(input.timelock.getTime() / 1000)),
    };

    const result = await client.lock(this.treasury.walletClient, params);
    return { ...result, payer: this.treasury.address };
  }

  async refund(lockId: Hex): Promise<string> {
    const escrow = this.requireEscrow();
    const client = new HtlcClient({ address: escrow, publicClient: this.treasury.publicClient });
    // Anyone may trigger a refund and the funds still go to the recorded payer,
    // so the platform can sweep expired escrows without the payer's key.
    return client.refund(this.treasury.walletClient, lockId);
  }

  private requireEscrow(): Address {
    if (!this.escrowAddress) {
      throw new Error(
        "HTLC_CONTRACT_ADDRESS is not set; deploy the escrow with " +
          "`pnpm --filter @cp/contracts deploy:htlc` and set it before settling an HTLC payment",
      );
    }
    return this.escrowAddress;
  }
}

/**
 * In-memory chain. Broadcasts nothing, but behaves like a ledger.
 *
 * Balances really move, so `mint` then `balanceOf` agrees, and a test of the
 * mint route is testing something. Compliance is deliberately NOT simulated:
 * that gate is proven on the real chain (D46), and a fake version here would
 * only teach the test suite to trust a rule the mock made up.
 */
export class MockChainGateway implements ChainGateway {
  readonly kind = "mock" as const;
  readonly broadcasts = false;
  readonly issuerAddress = "0x00000000000000000000000000000000000f0155" as Address;
  readonly treasuryAddress = "0x00000000000000000000000000000000000f7235" as Address;

  private readonly balances = new Map<string, bigint>();
  private readonly supply = new Map<string, bigint>();
  private readonly decimalsOf = new Map<string, number>();
  private readonly locks = new Map<Hex, { token: Address; payer: Address; amount: bigint }>();

  /** Null on purpose: there is nothing to link to, and a dead link reads as a bug. */
  explorerUrl(): string | null {
    return null;
  }

  async issueSecurity(input: IssueSecurityInput): Promise<IssuedSecurity> {
    const address = randomAddress();
    this.decimalsOf.set(key(address), input.decimals);
    this.supply.set(key(address), 0n);
    return { address, txHash: syntheticHash() };
  }

  async prepareSecurity(): Promise<{ txHashes: string[]; alreadyPrepared: boolean }> {
    return { txHashes: [syntheticHash()], alreadyPrepared: false };
  }

  async mint(security: Address, to: Address, baseUnits: bigint): Promise<string> {
    this.credit(security, to, baseUnits);
    this.supply.set(key(security), (this.supply.get(key(security)) ?? 0n) + baseUnits);
    return syntheticHash();
  }

  async transfer(security: Address, to: Address, baseUnits: bigint): Promise<string> {
    this.debit(security, this.treasuryAddress, baseUnits);
    this.credit(security, to, baseUnits);
    return syntheticHash();
  }

  async setCoupon(): Promise<string> {
    return syntheticHash();
  }

  async updateMaturity(): Promise<string> {
    return syntheticHash();
  }

  async redeem(security: Address, holder: Address, baseUnits: bigint): Promise<string> {
    this.debit(security, holder, baseUnits);
    this.supply.set(key(security), (this.supply.get(key(security)) ?? 0n) - baseUnits);
    return syntheticHash();
  }

  async decimals(security: Address): Promise<number> {
    return this.decimalsOf.get(key(security)) ?? 2;
  }

  async balanceOf(security: Address, holder: Address): Promise<bigint> {
    return this.balances.get(holdingKey(security, holder)) ?? 0n;
  }

  async totalSupply(security: Address): Promise<bigint> {
    return this.supply.get(key(security)) ?? 0n;
  }

  async chainTime(): Promise<Date> {
    return new Date();
  }

  async lock(input: LockInput): Promise<LockOutput> {
    const lockId = computeLockId({
      paymentRef: keccak256(toHex(input.paymentRequestId)),
      payer: this.treasuryAddress,
      payee: input.payee,
      token: input.token,
      amount: input.amount,
      hashlock: input.hashlock,
      timelock: BigInt(Math.floor(input.timelock.getTime() / 1000)),
    });

    this.debit(input.token, this.treasuryAddress, input.amount);
    this.locks.set(lockId, { token: input.token, payer: this.treasuryAddress, amount: input.amount });

    return {
      lockId,
      approveTxHash: syntheticHash(),
      lockTxHash: syntheticHash(),
      payer: this.treasuryAddress,
    };
  }

  async refund(lockId: Hex): Promise<string> {
    const entry = this.locks.get(lockId);
    if (entry) {
      this.credit(entry.token, entry.payer, entry.amount);
      this.locks.delete(lockId);
    }
    return syntheticHash();
  }

  private credit(security: Address, holder: Address, amount: bigint): void {
    const k = holdingKey(security, holder);
    this.balances.set(k, (this.balances.get(k) ?? 0n) + amount);
  }

  private debit(security: Address, holder: Address, amount: bigint): void {
    const k = holdingKey(security, holder);
    const held = this.balances.get(k) ?? 0n;
    // Mirrors the real token, which reverts rather than going negative. A mock
    // that let a balance go below zero would hide an accounting bug until the
    // one run that used the real chain.
    if (held < amount) {
      throw new Error(`mock chain: ${holder} holds ${held}, cannot move ${amount}`);
    }
    this.balances.set(k, held - amount);
  }
}

const key = (address: string) => address.toLowerCase();
const holdingKey = (security: string, holder: string) => `${key(security)}:${key(holder)}`;

/**
 * A hash that is obviously synthetic on inspection.
 *
 * Random rather than sequential so two mock operations never collide on a
 * unique column, and never presented without `broadcast: false` beside it.
 */
function syntheticHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function randomAddress(): Address {
  return `0x${randomBytes(20).toString("hex")}` as Address;
}
