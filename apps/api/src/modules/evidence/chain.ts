// Hash-chain primitives.
//
// Pure functions: no database, no network. The two things this product's
// credibility rests on — the decision engine and this chain — are testable in
// isolation, and neither can be quietly influenced by request context (D15).
//
// The DB write that uses these lives in service.ts, and MUST run in the same
// transaction as the state change it records (D07).
//
// Spec: docs/architecture.md §4.8

import { keccak256, toHex } from "viem";
import { GENESIS_PREVIOUS_HASH, type EvidencePayload } from "@cp/shared-types";
import { canonicalJsonStringify } from "../../lib/canonical-json.js";

export { GENESIS_PREVIOUS_HASH };

/** Serialises a payload to the exact bytes that get hashed. */
export function canonicalize(payload: EvidencePayload): string {
  return canonicalJsonStringify(payload);
}

/**
 * keccak256 over the canonical payload concatenated with the previous link.
 *
 * Including the predecessor is what makes this a chain rather than a list of
 * independent hashes: altering any earlier record changes every hash after it,
 * so a tamperer cannot fix up one row in isolation.
 *
 * Stored without the 0x prefix so every link — including the all-zero genesis —
 * has the same shape.
 */
export function computeRecordHash(payload: EvidencePayload, previousRecordHash: string): string {
  const preimage = `${canonicalize(payload)}${previousRecordHash}`;
  return keccak256(toHex(preimage)).slice(2);
}

export type ChainRecord = {
  payload: unknown;
  payloadHash: string;
  previousRecordHash: string;
};

export type ChainVerification = {
  chainValid: boolean;
  /** Index of the FIRST record that failed, null when the chain holds. */
  brokenAtIndex: number | null;
  reason: string | null;
};

/**
 * Recomputes the chain from genesis.
 *
 * Two independent failures are detected, and reporting which one matters:
 *
 *   content   a record's payload no longer hashes to its stored payloadHash —
 *             someone edited what the record says
 *   linkage   a record's previousRecordHash does not match its predecessor —
 *             a record was inserted, removed, or reordered
 *
 * Returns the first break rather than a bare boolean, because "the chain is
 * broken" is not actionable and "record 3 of 9 was altered" is.
 */
export function verifyChain(records: ChainRecord[]): ChainVerification {
  let expectedPrevious = GENESIS_PREVIOUS_HASH;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.previousRecordHash !== expectedPrevious) {
      return {
        chainValid: false,
        brokenAtIndex: index,
        reason:
          index === 0
            ? "first record does not start from genesis"
            : "record does not link to its predecessor",
      };
    }

    let recomputed: string;
    try {
      recomputed = computeRecordHash(record.payload as EvidencePayload, record.previousRecordHash);
    } catch (err) {
      return {
        chainValid: false,
        brokenAtIndex: index,
        reason: `payload could not be canonicalised: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    if (recomputed !== record.payloadHash) {
      return {
        chainValid: false,
        brokenAtIndex: index,
        reason: "payload does not hash to its stored payloadHash",
      };
    }

    expectedPrevious = record.payloadHash;
  }

  return { chainValid: true, brokenAtIndex: null, reason: null };
}
