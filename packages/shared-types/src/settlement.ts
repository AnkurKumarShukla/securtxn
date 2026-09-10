// HTLC settlement wire shapes.
//
// The API never broadcasts any of this. Signing happens in apps/approval-bridge
// and the transactions are reported here afterwards, exactly as a direct send
// is (D12, D32) — so every schema below describes something that has already
// happened on chain, not something the API is being asked to do.
//
// Spec: docs/architecture.md §4.5

import { z } from "zod";
import { HtlcStatus, SettlementMode } from "./enums.js";
import { AmountString, Bytes32, EvmAddress, IsoDateTime, Uuid } from "./primitives.js";

const TxHash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte transaction hash");

/**
 * POST /payments/:id/settlement/lock
 *
 * `lockId` is derived by the contract from every other field, so it is not
 * free-form: the API re-derives it and rejects a mismatch. A lock recorded
 * under an id the chain never issued is money the platform cannot later find.
 */
export const RecordLockRequest = z.object({
  escrowAddress: EvmAddress,
  lockId: Bytes32,
  /** keccak256 of the secret held by the payee. The secret itself never comes here. */
  hashlock: Bytes32,
  /** When the payer may take the funds back. */
  timelock: IsoDateTime,
  payerAddress: EvmAddress,
  /** The escrowed token's contract. Part of the lock id the contract derives. */
  tokenAddress: EvmAddress,
  amount: AmountString,
  /** The same amount in base units, exactly as the chain saw it. */
  onChainAmount: z.string().regex(/^[0-9]{1,78}$/, "must be a base-unit integer"),
  lockTxHash: TxHash,
});
export type RecordLockRequest = z.infer<typeof RecordLockRequest>;

/**
 * POST /payments/:id/settlement/claim
 *
 * The preimage is public the moment the claim is mined, so accepting it here
 * leaks nothing. It is checked against the stored hashlock — that check is what
 * turns a reported claim into evidence of receipt.
 */
export const RecordClaimRequest = z.object({
  preimage: Bytes32,
  claimTxHash: TxHash,
});
export type RecordClaimRequest = z.infer<typeof RecordClaimRequest>;

/** POST /payments/:id/settlement/refund */
export const RecordRefundRequest = z.object({
  refundTxHash: TxHash,
});
export type RecordRefundRequest = z.infer<typeof RecordRefundRequest>;

/**
 * POST /payments/:id/settle
 *
 * Releases an approved payment. DIRECT sends a transfer; HTLC opens an escrow
 * whose secret the platform generates here and hands over only once the payee
 * proves control of the payout address.
 */
export const SettleRequest = z.object({
  /**
   * Overrides the configured default. Bounded because a timelock of minutes
   * strands an honest payee in another timezone, and one of months leaves
   * misdirected money unrecoverable for exactly that long.
   */
  timelockSeconds: z.number().int().min(300).max(2_592_000).optional(),
});
export type SettleRequest = z.infer<typeof SettleRequest>;

export const SettleResponse = z.object({
  paymentRequestId: Uuid,
  mode: SettlementMode,
  status: z.enum(["SENT"]),
  txHash: z.string(),
  /** Null when nothing was broadcast, so a UI cannot link to a fiction. */
  explorerUrl: z.string().nullable(),
  /** False means no transaction exists on any chain (D21). */
  broadcast: z.boolean(),
  /** Present only for HTLC. The escrow the payee must now claim. */
  settlement: z.unknown().nullable(),
});
export type SettleResponse = z.infer<typeof SettleResponse>;

/**
 * POST /payments/:id/settlement/secret
 *
 * The payee signs an EIP-712 SecretRelease from the payout address. A role
 * token is not enough: whoever holds the preimage can take the money, so the
 * release is gated on control of the address the money is locked for.
 */
export const ReleaseSecretRequest = z.object({
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "must be a 0x-prefixed 65-byte signature"),
});
export type ReleaseSecretRequest = z.infer<typeof ReleaseSecretRequest>;

export const ReleaseSecretResponse = z.object({
  paymentRequestId: Uuid,
  lockId: Bytes32,
  escrowAddress: EvmAddress,
  /** The secret. Send it nowhere else, and never log it. */
  preimage: Bytes32,
  /** After this, claiming is closed and the payer may take the funds back. */
  timelock: IsoDateTime,
  onChainAmount: z.string(),
});
export type ReleaseSecretResponse = z.infer<typeof ReleaseSecretResponse>;

/** POST /settlement/sweep-refunds */
export const RefundSweepResult = z.object({
  expiredFound: z.number().int(),
  refunded: z.array(z.object({ paymentRequestId: Uuid, lockId: Bytes32, txHash: z.string() })),
  failed: z.array(z.object({ paymentRequestId: Uuid, reason: z.string() })),
});
export type RefundSweepResult = z.infer<typeof RefundSweepResult>;

export const SettlementSummary = z.object({
  paymentRequestId: Uuid,
  mode: SettlementMode,
  status: HtlcStatus,
  escrowAddress: EvmAddress,
  lockId: Bytes32,
  hashlock: Bytes32,
  timelock: IsoDateTime,
  payerAddress: EvmAddress,
  payeeAddress: EvmAddress,
  tokenAddress: EvmAddress,
  amount: AmountString,
  onChainAmount: z.string(),
  lockTxHash: z.string(),
  claimTxHash: z.string().nullable(),
  refundTxHash: z.string().nullable(),
  /** Null until claimed. Once set, this is the receipt the payee published. */
  preimage: Bytes32.nullable(),
  lockedAt: IsoDateTime,
  settledAt: IsoDateTime.nullable(),
});
export type SettlementSummary = z.infer<typeof SettlementSummary>;
