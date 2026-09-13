// Payment request, decision, and proposal wire shapes.
// Spec: docs/architecture.md §4.1

import { z } from "zod";
import { PaymentDecision, PaymentStatus, SettlementMode } from "./enums.js";
import { AmountString, Bytes32, EvmAddress, Network, Uuid } from "./primitives.js";

/** POST /payments */
export const CreatePaymentRequest = z.object({
  vendorId: Uuid,
  /**
   * Explicit rather than "the vendor's current wallet". Wallets are versioned
   * (D01), and a payment must name the exact version it was authorised
   * against — otherwise a rotation between decision and send silently
   * redirects the money.
   */
  vendorWalletId: Uuid,
  /**
   * The paying party. Both sides onboard through the same path, so a payer is
   * a Vendor too — no second identity stack, and the payer's DigiLocker name is
   * what the payee sees when asked to consent (P3).
   */
  payerVendorId: Uuid,
  /**
   * Who the sender BELIEVES they are paying, straight off the invoice.
   *
   * The address above is untrusted routing; this is the verification. Sent as
   * plaintext over TLS and immediately reduced to digests server-side — it is
   * never stored in the clear and never reaches the enclave (D62).
   *
   * Without it there is no claim to check, and the old code compared the
   * payee's record to itself, which could never fail.
   */
  intendedPayeeName: z.string().min(1).max(200),
  /** Indian PAN: 5 letters, 4 digits, 1 letter. GSTIN embeds it. */
  intendedPayeePan: z.string().regex(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, "must be a valid PAN"),
  invoiceRef: z.string().min(1).max(100),
  amount: AmountString,
  token: z.string().min(1).max(20),
  network: Network,
  /**
   * Opt-in, and DIRECT when omitted. HTLC settlement is stronger evidence but
   * it requires the payee to act, so making it the default would strand any
   * payee who never claims. The safe mode has to be the one that always pays
   * (D41).
   */
  settlementMode: SettlementMode.default("DIRECT"),
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequest>;

/**
 * Why a decision came out the way it did. A stable code, not prose: it is
 * written into the evidence chain and read back during a dispute, so it has to
 * mean the same thing months later.
 */
export const DecisionReasonCode = z.enum([
  "SANCTIONS_HIT",
  "DUPLICATE_PAYMENT",
  "WALLET_NOT_CONFIRMED",
  "TIER_UNVERIFIED",
  "VENDOR_MATCH_FAILED",
  /**
   * The token itself has not been told this address may hold it (O8).
   *
   * Distinct from every other refusal here: the others are our policy, this
   * one is the chain's. A transfer attempted anyway reverts on-chain, so
   * surfacing it as a decision turns a failed transaction into an answer.
   */
  "ONCHAIN_KYC_NOT_GRANTED",
  "AMOUNT_EXCEEDS_TIER_LIMIT",
  "NEW_OR_CHANGED_ADDRESS",
  "ALL_CHECKS_PASSED",
]);
export type DecisionReasonCode = z.infer<typeof DecisionReasonCode>;

export const DecisionResult = z.object({
  decision: PaymentDecision,
  reasonCode: DecisionReasonCode,
  /** Vendor-match confidence, 0–1. Null when the decision short-circuited. */
  /** Null since D62 — digest matching is exact, so there is no score. */
  matchScore: z.number().min(0).max(1).nullable(),
  /**
   * Advisory only — it changes nothing about the decision above.
   *
   * The engine has just worked out how much it trusts this payout, and that is
   * exactly the input for choosing a settlement mode. A first payment to a
   * newly seen address is the case where an unclaimed escrow refunding beats a
   * transfer that cannot be undone.
   */
  recommendedSettlementMode: SettlementMode,
});
export type DecisionResult = z.infer<typeof DecisionResult>;

export const PaymentSummary = z.object({
  id: Uuid,
  vendorId: Uuid,
  vendorWalletId: Uuid,
  invoiceRef: z.string(),
  amount: AmountString,
  token: z.string(),
  network: Network,
  status: PaymentStatus,
  settlementMode: SettlementMode,
  decision: PaymentDecision.nullable(),
  decisionReasonCode: DecisionReasonCode.nullable(),
  matchScore: z.number().nullable(),
  txHash: z.string().nullable(),
  senderContextCommitment: Bytes32,
  createdAt: z.string().datetime(),
});
export type PaymentSummary = z.infer<typeof PaymentSummary>;

/**
 * POST /payments/:id/acknowledgment
 *
 * The recipient signs a commitment over the payment context. This is
 * non-repudiation of receipt: the payee cannot later claim they never received
 * it, and the raw context stays off-chain (design principle 2).
 */
export const AcknowledgmentRequest = z.object({
  recipientAddress: EvmAddress,
  recipientSignature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
  /**
   * The raw context the recipient acknowledged. Hashed to produce the
   * commitment, then stored encrypted — never on chain (design principle 2).
   */
  acknowledgedContext: z.object({
    invoiceRef: z.string(),
    amount: AmountString,
    token: z.string(),
    txHash: z.string(),
    note: z.string().max(500).optional(),
  }),
});
export type AcknowledgmentRequest = z.infer<typeof AcknowledgmentRequest>;

export const AcknowledgmentResponse = z.object({
  paymentRequestId: Uuid,
  recipientAddress: EvmAddress,
  /** keccak256 over the canonical acknowledged context. */
  recipientCommitment: Bytes32,
  verifiedAt: z.string().datetime(),
});
export type AcknowledgmentResponse = z.infer<typeof AcknowledgmentResponse>;

/**
 * GET /payments — the list behind the payments screen.
 *
 * WHY A SEPARATE SHAPE FROM `PaymentSummary`. A list row answers "which of
 * these needs me?", and the two things that answer it — who is being paid, and
 * how far along it is — are not on the summary: `vendorId` is a uuid, and a
 * uuid tells an operator nothing. So the payee's display name is resolved at
 * read time and joined in here.
 *
 * It is resolved rather than stored for the same reason the consent prompt
 * resolves it: a name copied into a row at creation time is a name that goes
 * stale the moment the vendor is renamed.
 */
export const PaymentListItem = z.object({
  id: Uuid,
  invoiceRef: z.string(),
  amount: AmountString,
  token: z.string(),
  network: Network,
  status: PaymentStatus,
  settlementMode: SettlementMode,
  decision: PaymentDecision.nullable(),
  decisionReasonCode: z.string().nullable(),
  /** Resolved at read time from the payee's vendor record. */
  payeeName: z.string().nullable(),
  payeeVendorId: Uuid,
  payerVendorId: Uuid.nullable(),
  txHash: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type PaymentListItem = z.infer<typeof PaymentListItem>;

export const PaymentListQuery = z.object({
  /** Narrow to one lifecycle state, for the list's status filter. */
  status: PaymentStatus.optional(),
  /** Only payments this org raised. The dashboard always sends its own id. */
  payerVendorId: Uuid.optional(),
  /** Only payments addressed to this payee. */
  vendorId: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** An id from a previous page's `nextCursor`. Keyset, not offset. */
  cursor: Uuid.optional(),
});
export type PaymentListQuery = z.infer<typeof PaymentListQuery>;

export const PaymentList = z.object({
  items: z.array(PaymentListItem),
  /** Absent when this is the last page. */
  nextCursor: Uuid.nullable(),
});
export type PaymentList = z.infer<typeof PaymentList>;
