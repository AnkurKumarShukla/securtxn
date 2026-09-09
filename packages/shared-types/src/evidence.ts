// Canonical evidence payloads, one schema per eventType.
//
// These schemas ARE the enforcement of docs/evidence-schema.md. A payload that
// does not parse is not written, which keeps the chain describable months later
// when someone has to read it in a dispute.
//
// Design principle 2: no raw PII, banking details, location or device
// fingerprints in any payload. Commitment hashes only. Every field below is
// either an identifier, an enum, a score, or a hash — check that property
// before adding one.
//
// Spec: docs/architecture.md §4.8

import { z } from "zod";
import { ExceptionType, PaymentDecision } from "./enums.js";
import { AmountString, Bytes32, EvmAddress, IsoDateTime, Bytes32Hex, Uuid } from "./primitives.js";
import { DecisionReasonCode } from "./payment.js";

export const EvidenceEventType = z.enum([
  "vendor_match",
  "decision",
  "approval",
  "send",
  "ack",
  "exception_opened",
  /** Reading the audit trail is itself audited (D18). */
  "evidence_accessed",
]);
export type EvidenceEventType = z.infer<typeof EvidenceEventType>;

/** Genesis link value for the first record in a chain. */
export const GENESIS_PREVIOUS_HASH = "0".repeat(64);

const base = { paymentRequestId: Uuid, timestamp: IsoDateTime };

/**
 * Discriminated on eventType so `data` is checked against the right shape.
 * A single loose `Record<string, unknown>` would let anything through,
 * including the PII this format exists to keep out.
 */
export const EvidencePayload = z.discriminatedUnion("eventType", [
  z.object({
    ...base,
    eventType: z.literal("vendor_match"),
    data: z.object({
      matched: z.boolean(),
      score: z.number().min(0).max(1),
      reasonCode: z.string(),
      /** Which implementation produced this — fallback or the CRE enclave (D09). */
      matcher: z.enum(["fallback", "cre"]),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("decision"),
    data: z.object({
      decision: PaymentDecision,
      reasonCode: DecisionReasonCode,
      matchScore: z.number().nullable(),
      /** The ceiling applied, so a later reader can reproduce the call (D08). */
      tierLimitApplied: AmountString.nullable(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("approval"),
    data: z.object({
      approverId: z.string(),
      selfieCheckVerified: z.boolean(),
      ledgerConfirmed: z.boolean(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("send"),
    data: z.object({
      txHash: z.string(),
      network: z.string(),
      /** Address is on-chain public data already; the amount is not sensitive alone. */
      toAddress: EvmAddress,
      amount: AmountString,
      token: z.string(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("ack"),
    data: z.object({
      recipientAddress: EvmAddress,
      /** The raw acknowledged context stays off-chain, encrypted. */
      recipientCommitment: Bytes32,
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("exception_opened"),
    data: z.object({
      exceptionType: ExceptionType,
      openedBy: z.string(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("evidence_accessed"),
    data: z.object({
      /** Who read the chain, and under which role (D18). */
      actorId: z.string(),
      actorRole: z.string(),
    }),
  }),
]);
export type EvidencePayload = z.infer<typeof EvidencePayload>;

/** One stored record, as returned by GET /payments/:id/evidence. */
export const EvidenceRecordSummary = z.object({
  id: Uuid,
  eventType: EvidenceEventType,
  /** The canonical payload itself, so the chain can be re-derived (D36). */
  payload: z.unknown(),
  payloadHash: Bytes32Hex,
  previousRecordHash: Bytes32Hex,
  /** Null until the batch anchoring job runs (D19). */
  hcsAnchorTxId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type EvidenceRecordSummary = z.infer<typeof EvidenceRecordSummary>;

export const EvidenceChainResponse = z.object({
  paymentRequestId: Uuid,
  records: z.array(EvidenceRecordSummary),
  /** Recomputed from genesis on every read, not stored (§4.8). */
  chainValid: z.boolean(),
  /** Index of the first record that failed to verify, null when the chain holds. */
  brokenAtIndex: z.number().int().nullable(),
});
export type EvidenceChainResponse = z.infer<typeof EvidenceChainResponse>;
