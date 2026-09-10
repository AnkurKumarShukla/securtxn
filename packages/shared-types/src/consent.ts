// P3-P4 — the payee's side of a payment.
//
// The control this exists for: nothing about the payee is verified until the
// payee agrees to be verified. A sender who wants to use the identity check as
// a lookup oracle must first get the holder of the target address to accept a
// named amount against a named invoice, and that acceptance is signed by the
// key the money would go to.
//
// Spec: docs/payment-flow.md (P3-P5)

import { z } from "zod";
import { NotificationKind, PayeeConsentDecision } from "./enums.js";
import { AmountString, EvmAddress, IsoDateTime, Uuid } from "./primitives.js";

/** Signatures are 65 bytes: r, s and v. */
const Signature = z
  .string()
  .regex(/^0x[a-fA-F0-9]{130}$/, "must be a 0x-prefixed 65-byte signature");

/**
 * POST /payments/:id/request-consent
 *
 * Takes no body. Everything it needs is already on the payment, and accepting
 * an amount or an address here would let the request describe something other
 * than what was raised at P1.
 */
export const RequestConsentResponse = z.object({
  paymentRequestId: Uuid,
  notificationId: Uuid,
  status: z.literal("AWAITING_PAYEE_CONSENT"),
  /**
   * Whether the payee will have to prove personhood to accept (P5), and what
   * tripped it. Returned up-front so the payee is told before they start, not
   * after they have signed.
   *
   * Advisory at this point: it is recomputed when the decision arrives, because
   * the risk picture can change between the request and the answer.
   */
  challengeRequired: z.boolean(),
  challengeTriggers: z.array(z.string()),
});
export type RequestConsentResponse = z.infer<typeof RequestConsentResponse>;

/**
 * POST /payments/:id/consent
 *
 * `signature` and `signerAddress` are required to ACCEPT and forbidden on a
 * DENY: refusing a payment needs no proof of anything, while accepting one has
 * to come from the key that would receive it.
 */
export const PayeeConsentRequest = z
  .object({
    decision: PayeeConsentDecision,
    signature: Signature.optional(),
    signerAddress: EvmAddress.optional(),
    /** The World ID verification id, when the risk engine asked for one (P5). */
    worldIdVerificationId: Uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "ACCEPTED" && (!value.signature || !value.signerAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "accepting requires a signature from the confirmed payout address",
      });
    }
    if (value.decision === "DENIED" && (value.signature || value.signerAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a denial carries no signature",
      });
    }
  });
export type PayeeConsentRequest = z.infer<typeof PayeeConsentRequest>;

export const PayeeConsentResponse = z.object({
  paymentRequestId: Uuid,
  decision: PayeeConsentDecision,
  /** DECISION_PENDING once accepted; the payment stops dead on a denial. */
  status: z.string(),
  decidedAt: IsoDateTime,
});
export type PayeeConsentResponse = z.infer<typeof PayeeConsentResponse>;

/**
 * What the payee is shown before deciding.
 *
 * The payer's legal name is resolved here, at read time, from their vendor
 * record — it is deliberately NOT copied into the stored notification payload,
 * which stays identifiers-only like every other record in this system.
 */
export const ConsentPrompt = z.object({
  paymentRequestId: Uuid,
  payerVendorId: Uuid,
  payerLegalName: z.string(),
  /** The payer's own verification level. A payee should see who is asking. */
  payerVerificationTier: z.string(),
  amount: AmountString,
  token: z.string(),
  network: z.string(),
  invoiceRef: z.string(),
  payeeAddress: EvmAddress,
  requestedAt: IsoDateTime,
});
export type ConsentPrompt = z.infer<typeof ConsentPrompt>;

export const NotificationSummary = z.object({
  id: Uuid,
  kind: NotificationKind,
  paymentRequestId: Uuid.nullable(),
  payload: z.record(z.unknown()),
  readAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type NotificationSummary = z.infer<typeof NotificationSummary>;

/**
 * POST /vendors/:id/blocks
 *
 * Keyed on the payer's VENDOR id, not an address. Addresses rotate in seconds;
 * a DigiLocker-backed identity does not, so blocking the identity is the only
 * form of block that survives the attacker's cheapest move.
 */
export const CreateBlockRequest = z.object({
  blockedVendorId: Uuid,
  reason: z.string().max(500).optional(),
});
export type CreateBlockRequest = z.infer<typeof CreateBlockRequest>;

export const BlockSummary = z.object({
  id: Uuid,
  blockedByVendorId: Uuid,
  blockedVendorId: Uuid,
  reason: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type BlockSummary = z.infer<typeof BlockSummary>;
