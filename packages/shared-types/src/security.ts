// Tokenized instruments: issuance and lifecycle wire shapes.
//
// These are the endpoints a treasury operator drives from the UI. Everything
// here is issuer-scoped: creating an instrument and minting units are not
// payment operations, and they must not be reachable with an agent or approver
// token (D12).
//
// AMOUNTS ARE HUMAN DECIMAL STRINGS, not base units. The API reads the token's
// `decimals()` from chain and scales. A UI that had to know the scale would
// eventually get it wrong by two, which is the difference between paying a
// vendor and paying them a hundred times over.
//
// Spec: docs/architecture.md §4.5

import { z } from "zod";
import { SecurityStatus, SecurityEventKind } from "./enums.js";
import { AmountString, EvmAddress, IsoDateTime, Uuid } from "./primitives.js";

/** ISO 6166: two-letter country, nine alphanumerics, one check digit. */
export const Isin = z
  .string()
  .regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, "must be a 12-character ISIN");

const TxHash = z.string();

/** POST /securities */
export const IssueSecurityRequest = z.object({
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(12),
  /**
   * Optional. When omitted the API generates one with a valid check digit —
   * the factory rejects a bad checksum with `WrongISINChecksum`, and asking a
   * UI to compute ISO 6166 by hand invites exactly that revert.
   */
  isin: Isin.optional(),
  decimals: z.number().int().min(0).max(18).default(2),
  currency: z.string().length(3).default("USD"),
  /** Face value per unit, human decimal. */
  nominalValue: AmountString,
  nominalValueDecimals: z.number().int().min(0).max(18).default(2),
  /** Total units that may ever exist, human decimal. Must be above zero. */
  maxSupply: AmountString,
  startingDate: IsoDateTime.optional(),
  maturityDate: IsoDateTime,
});
export type IssueSecurityRequest = z.infer<typeof IssueSecurityRequest>;

export const SecuritySummary = z.object({
  id: Uuid,
  evmAddress: EvmAddress,
  hederaId: z.string().nullable(),
  name: z.string(),
  symbol: z.string(),
  isin: z.string(),
  decimals: z.number().int(),
  currency: z.string(),
  nominalValue: AmountString,
  maxSupply: z.string(),
  startingDate: IsoDateTime,
  maturityDate: IsoDateTime,
  status: SecurityStatus,
  /** False means grantKyc against this security will revert (D40). */
  issuerRegistered: z.boolean(),
  deployTxHash: TxHash,
  /** Null when the chain gateway is mocked; otherwise a HashScan link. */
  explorerUrl: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type SecuritySummary = z.infer<typeof SecuritySummary>;

export const SecurityEventSummary = z.object({
  id: Uuid,
  kind: SecurityEventKind,
  txHash: TxHash,
  actorId: z.string(),
  detail: z.unknown(),
  createdAt: IsoDateTime,
});
export type SecurityEventSummary = z.infer<typeof SecurityEventSummary>;

/**
 * POST /securities/:id/mint
 *
 * Exactly one destination. A receivable minted straight to the supplier is the
 * common case; minting to the platform's own treasury is how an instrument gets
 * funded before it is paid out through a transfer or an escrow.
 */
export const MintRequest = z
  .object({
    /**
     * The vendor wallet receiving the units. Named by id, not raw address: the
     * wallet must be one the platform CONFIRMED, and accepting an address here
     * would let a caller mint to anywhere (D01).
     */
    vendorWalletId: Uuid.optional(),
    /** Mint into the platform treasury instead, to be paid out later. */
    toTreasury: z.boolean().optional(),
    amount: AmountString,
  })
  .refine(
    (v) => Boolean(v.vendorWalletId) !== Boolean(v.toTreasury),
    "name exactly one destination: vendorWalletId or toTreasury",
  );
export type MintRequest = z.infer<typeof MintRequest>;

/** POST /securities/:id/coupon */
export const SetCouponRequest = z.object({
  /** Holders at this moment receive it. Must be before the execution date. */
  recordDate: IsoDateTime,
  executionDate: IsoDateTime,
  /** Percentage rate, e.g. "2.50". Scaled by rateDecimals on chain. */
  rate: z.string().regex(/^\d{1,4}(\.\d{1,4})?$/, "must be a percentage like 2.50"),
  rateDecimals: z.number().int().min(0).max(6).default(2),
});
export type SetCouponRequest = z.infer<typeof SetCouponRequest>;

/** PATCH /securities/:id/maturity */
export const UpdateMaturityRequest = z.object({
  /** Must be strictly in the future; the contract rejects anything else. */
  maturityDate: IsoDateTime,
});
export type UpdateMaturityRequest = z.infer<typeof UpdateMaturityRequest>;

/** POST /securities/:id/redeem — the manual override on the maturity sweep. */
export const RedeemRequest = z.object({
  vendorWalletId: Uuid,
  /** Omit to redeem the holder's entire balance. */
  amount: AmountString.optional(),
});
export type RedeemRequest = z.infer<typeof RedeemRequest>;

/** What a lifecycle call returns once its transaction is confirmed. */
export const ChainOperationResult = z.object({
  securityId: Uuid,
  kind: SecurityEventKind,
  txHash: TxHash,
  /** Null when the chain gateway is mocked, so a caller can never mistake one. */
  explorerUrl: z.string().nullable(),
  /** True only when a real transaction exists on a real chain (D21). */
  broadcast: z.boolean(),
  detail: z.unknown(),
});
export type ChainOperationResult = z.infer<typeof ChainOperationResult>;

export const SecurityHolding = z.object({
  address: EvmAddress,
  /** Human decimal, scaled by the token's own decimals. */
  balance: z.string(),
  balanceBaseUnits: z.string(),
});
export type SecurityHolding = z.infer<typeof SecurityHolding>;
