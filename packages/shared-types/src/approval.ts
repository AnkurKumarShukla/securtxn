// The contract between apps/api and apps/approval-bridge.
//
// This is the only shape crossing the boundary between the process that decides
// and the process that signs (D12). The bridge imports nothing else from the
// API — it talks HTTP and parses these.
//
// Spec: docs/architecture.md §4.3

import { z } from "zod";
import { PaymentDecision } from "./enums.js";
import { AmountString, EvmAddress, IsoDateTime, Network, Uuid } from "./primitives.js";
import { DecisionReasonCode } from "./payment.js";

/**
 * One row in the approver's queue, as printed to the terminal before the
 * device prompt.
 *
 * Everything here exists to be read by a human deciding whether to sign. It
 * carries no PII beyond the vendor's display name: the operator needs to
 * recognise the payee, not review their identity documents (D06).
 */
export const PendingProposal = z.object({
  id: Uuid,
  paymentRequestId: Uuid,
  vendorName: z.string(),
  invoiceRef: z.string(),
  address: EvmAddress,
  network: Network,
  amount: AmountString,
  token: z.string(),
  decision: PaymentDecision,
  decisionReasonCode: DecisionReasonCode,
  /**
   * True when this address has not been paid before. The operator should be
   * looking harder at these, and the decision engine will usually have
   * returned SEND_TEST_AMOUNT.
   */
  isNewOrChangedAddress: z.boolean(),
  proposedAt: IsoDateTime,
});
export type PendingProposal = z.infer<typeof PendingProposal>;

export const PendingProposalList = z.object({
  proposals: z.array(PendingProposal),
});
export type PendingProposalList = z.infer<typeof PendingProposalList>;

/**
 * POST /approvals/:id/report-sent
 *
 * Posted by the bridge after wallet-cli returns. The API never observes the
 * signing itself — it learns the outcome from this call, which is why the
 * bridge is the only thing that ever holds a key.
 */
export const ReportSentRequest = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte transaction hash"),
  /** When the device confirmed, not when this request was made. */
  ledgerConfirmedAt: IsoDateTime,
  approverId: z.string().min(1).max(100),
});
export type ReportSentRequest = z.infer<typeof ReportSentRequest>;

export const ReportSentResponse = z.object({
  paymentRequestId: Uuid,
  status: z.literal("SENT"),
  txHash: z.string(),
});
export type ReportSentResponse = z.infer<typeof ReportSentResponse>;

/**
 * POST /payments/:id/propose — agent role only.
 *
 * Writing a proposal is the furthest autonomous code can go. It cannot approve
 * one, and the API rejects an approver token here (design principle 1, D12).
 */
export const CreateProposalRequest = z.object({
  /**
   * World ID Selfie Check reference, when the flow captured one. Opaque by
   * design: the server-side response shape is undocumented, so nothing here
   * depends on its internals (§4.6).
   */
  selfieCheckProofRef: z.string().max(500).optional(),
});
export type CreateProposalRequest = z.infer<typeof CreateProposalRequest>;
