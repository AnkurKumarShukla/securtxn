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
  "AMOUNT_EXCEEDS_TIER_LIMIT",
  "NEW_OR_CHANGED_ADDRESS",
  "ALL_CHECKS_PASSED",
]);
export type DecisionReasonCode = z.infer<typeof DecisionReasonCode>;

export const DecisionResult = z.object({
  decision: PaymentDecision,
  reasonCode: DecisionReasonCode,
  /** Vendor-match confidence, 0–1. Null when the decision short-circuited. */
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
