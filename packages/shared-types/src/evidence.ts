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
import { ExceptionType, PayeeConsentDecision, PaymentDecision } from "./enums.js";
import { AmountString, Bytes32, EvmAddress, IsoDateTime, Bytes32Hex, Uuid } from "./primitives.js";
import { AcknowledgmentMethod } from "./enums.js";
import { DecisionReasonCode } from "./payment.js";

export const EvidenceEventType = z.enum([
  /** P4: the payee accepted or denied being paid — and being verified. */
  "payee_consent",
  /** P2/P5: a live human proved continuity with an earlier enrolment. */
  "world_id_check",
  "vendor_match",
  "decision",
  "approval",
  "send",
  "ack",
  /** The three HTLC settlement outcomes, each its own record (D41). */
  "htlc_locked",
  "htlc_claimed",
  "htlc_refunded",
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
    eventType: z.literal("payee_consent"),
    data: z.object({
      decision: PayeeConsentDecision,
      /**
       * The address that signed. On-chain public data, and the whole point of
       * the record: a dispute turns on WHICH key accepted, not on who claimed to.
       */
      signerAddress: EvmAddress.nullable(),
      /** Absent on a denial — refusing needs no proof, accepting does. */
      signaturePresent: z.boolean(),
      /** The World ID check the risk engine demanded, when it demanded one (P5). */
      worldIdVerificationId: Uuid.nullable(),
      /** Which rules fired. Empty when the payee was not challenged. */
      challengeTriggers: z.array(z.string()),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("world_id_check"),
    data: z.object({
      verificationId: Uuid,
      /** ENROLLMENT or REVERIFICATION — assurance differs, so never inferred. */
      purpose: z.string(),
      /** "selfie", "orb", … The credential is what bounds the claim (D49b). */
      credential: z.string(),
      /**
       * Whose check this was. Both sides verify at different points and a
       * record that did not say which would be unreadable in a dispute.
       */
      party: z.enum(["sender", "payee"]),
      /**
       * NEVER the nullifier itself. It is a stable per-person identifier
       * within an action, so publishing it in an anchored chain would let
       * anyone holding two records link the same human across payments —
       * exactly the correlation World ID's design avoids (design principle 2).
       */
      nullifierMatchedEnrolment: z.boolean(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("vendor_match"),
    data: z.object({
      matched: z.boolean(),
      /**
       * Null since D62: the match compares HMAC digests, which are exact, so
       * there is no meaningful number between 0 and 1. Kept nullable rather
       * than removed so records written before the change stay readable.
       */
      score: z.number().min(0).max(1).nullable(),
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
      /**
       * Which route produced it. A dispute turns on how strong the receipt is,
       * and a signature the payee was asked for is not the same evidence as a
       * secret they revealed to collect the money (D41).
       */
      method: AcknowledgmentMethod,
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("htlc_locked"),
    data: z.object({
      escrowAddress: EvmAddress,
      lockId: Bytes32,
      /** The hash, never the secret — the secret is what the payee spends. */
      hashlock: Bytes32,
      timelock: IsoDateTime,
      amount: AmountString,
      txHash: z.string(),
      /**
       * Whose money is in the escrow.
       *
       * Material rather than decorative: the contract refunds to whoever sent
       * the lock, so this says where the funds return if nobody claims. A
       * reader auditing a refund months later cannot infer it from anything
       * else in the chain. Optional because records written before payer
       * funding existed do not carry it, and rewriting history to add a field
       * would break every hash after it.
       */
      fundedBy: z.enum(["payer", "treasury"]).optional(),
      payerAddress: EvmAddress.optional(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("htlc_claimed"),
    data: z.object({
      lockId: Bytes32,
      /** Public the moment the claim was mined; recording it proves the match. */
      preimage: Bytes32,
      claimedBy: EvmAddress,
      txHash: z.string(),
    }),
  }),
  z.object({
    ...base,
    eventType: z.literal("htlc_refunded"),
    data: z.object({
      lockId: Bytes32,
      /** Where the money went back to, which is the whole point of the record. */
      refundedTo: EvmAddress,
      amount: AmountString,
      txHash: z.string(),
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

// --- consensus anchoring (§4.8, D19) ---------------------------------------

/**
 * The message published to the topic.
 *
 * Deliberately tiny and self-describing. It has to fit one HCS message, and it
 * has to still make sense to someone who finds it years from now with no access
 * to this system — so it carries a version, the root, and how many records it
 * covers, and nothing that would need our database to interpret.
 */
export const AnchorMessage = z.object({
  v: z.literal(1),
  kind: z.literal("evidence-anchor"),
  /** keccak256 Merkle root over the batch's payload hashes. */
  root: Bytes32,
  count: z.number().int().positive(),
  /** Our clock, stated as ours. The consensus timestamp is the real one. */
  submittedAt: IsoDateTime,
});
export type AnchorMessage = z.infer<typeof AnchorMessage>;

export const AnchorSummary = z.object({
  id: Uuid,
  merkleRoot: Bytes32,
  recordCount: z.number().int(),
  topicId: z.string(),
  sequenceNumber: z.number().int(),
  consensusTimestamp: z.string(),
  transactionId: z.string(),
  /** Public mirror-node URL. Null when nothing was published (D21). */
  messageUrl: z.string().nullable(),
  /** True once a mirror node served the message back to us. */
  verified: z.boolean(),
  createdAt: IsoDateTime,
});
export type AnchorSummary = z.infer<typeof AnchorSummary>;

/** POST /evidence/anchor */
export const AnchorRunResult = z.object({
  /** Records that were waiting. Zero is a normal, successful outcome. */
  recordsAnchored: z.number().int(),
  anchor: AnchorSummary.nullable(),
  /** False when the gateway is mocked, so nothing can be presented as public. */
  broadcast: z.boolean(),
});
export type AnchorRunResult = z.infer<typeof AnchorRunResult>;

/** One sibling on the path from a leaf to the root. */
export const InclusionProofStep = z.object({
  hash: Bytes32,
  position: z.enum(["left", "right"]),
});

/**
 * GET /evidence/:id/proof
 *
 * Everything a third party needs to check that this record was committed to
 * before the consensus timestamp, without asking us again: the leaf, the
 * siblings, the root, and the public URL of the message that root was published
 * in. The verification itself is keccak256 and nothing else.
 */
export const InclusionProof = z.object({
  evidenceRecordId: Uuid,
  paymentRequestId: Uuid,
  /** The record's payloadHash, which is the tree leaf. */
  leaf: Bytes32,
  /** Position in the ordered batch. */
  index: z.number().int(),
  steps: z.array(InclusionProofStep),
  root: Bytes32,
  anchor: AnchorSummary,
  /**
   * How to check it, stated in the response rather than in documentation
   * somebody has to find. Prefixes are what stop an internal node posing as a
   * leaf.
   */
  algorithm: z.object({
    hash: z.literal("keccak256"),
    leaf: z.literal("keccak256(0x00 || payloadHash)"),
    node: z.literal("keccak256(0x01 || left || right)"),
    oddNode: z.literal("promoted unchanged, never duplicated"),
  }),
});
export type InclusionProof = z.infer<typeof InclusionProof>;
