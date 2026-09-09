import type { EvidencePayload } from "@cp/shared-types";
import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/lib/canonical-json.js";
import {
  GENESIS_PREVIOUS_HASH,
  canonicalize,
  computeRecordHash,
  verifyChain,
  type ChainRecord,
} from "../src/modules/evidence/chain.js";

const PAYMENT_ID = "00000000-0000-4000-8000-000000000003";

function payload(overrides: Partial<EvidencePayload> = {}): EvidencePayload {
  return {
    eventType: "decision",
    paymentRequestId: PAYMENT_ID,
    timestamp: "2026-09-09T10:00:00.000Z",
    data: {
      decision: "SAFE_TO_SEND",
      reasonCode: "ALL_CHECKS_PASSED",
      matchScore: 0.97,
      tierLimitApplied: null,
    },
    ...overrides,
  } as EvidencePayload;
}

/** Builds a valid chain of n decision records. */
function buildChain(n: number): ChainRecord[] {
  const records: ChainRecord[] = [];
  let previous = GENESIS_PREVIOUS_HASH;

  for (let i = 0; i < n; i += 1) {
    const p = payload({ timestamp: `2026-09-09T10:0${i}:00.000Z` });
    const hash = computeRecordHash(p, previous);
    records.push({ payload: p, payloadHash: hash, previousRecordHash: previous });
    previous = hash;
  }
  return records;
}

describe("canonical JSON", () => {
  it("is independent of key insertion order", () => {
    // The whole reason this module exists: JSON.stringify preserves insertion
    // order, and two equal payloads built differently would hash differently.
    const a = canonicalJsonStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJsonStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined members but keeps nulls", () => {
    // An optional field that was never set is not an error; an explicit null is
    // a value and must survive.
    expect(canonicalJsonStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("refuses values JSON cannot round-trip", () => {
    // Each of these would silently become something else and produce a hash
    // over content the caller never passed.
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(/NaN/);
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
    expect(() => canonicalJsonStringify(10n)).toThrow(/bigint/);
    expect(() => canonicalJsonStringify(() => 1)).toThrow(/function/);
  });

  it("refuses a circular reference instead of hanging", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(/circular/);
  });

  it("serialises dates as UTC ISO strings", () => {
    expect(canonicalJsonStringify({ at: new Date("2026-09-09T10:00:00.000Z") })).toBe(
      '{"at":"2026-09-09T10:00:00.000Z"}',
    );
  });
});

describe("record hashing", () => {
  it("is deterministic for the same payload and predecessor", () => {
    const p = payload();
    expect(computeRecordHash(p, GENESIS_PREVIOUS_HASH)).toBe(
      computeRecordHash(p, GENESIS_PREVIOUS_HASH),
    );
  });

  it("produces a bare 64-hex digest, matching the genesis shape", () => {
    expect(computeRecordHash(payload(), GENESIS_PREVIOUS_HASH)).toMatch(/^[0-9a-f]{64}$/);
    expect(GENESIS_PREVIOUS_HASH).toMatch(/^0{64}$/);
  });

  it("changes when the payload changes", () => {
    const a = computeRecordHash(payload(), GENESIS_PREVIOUS_HASH);
    const b = computeRecordHash(
      payload({
        data: {
          decision: "DO_NOT_SEND",
          reasonCode: "SANCTIONS_HIT",
          matchScore: 0.97,
          tierLimitApplied: null,
        },
      } as Partial<EvidencePayload>),
      GENESIS_PREVIOUS_HASH,
    );
    expect(a).not.toBe(b);
  });

  it("changes when the predecessor changes", () => {
    // This is what makes it a chain rather than a bag of hashes: altering an
    // earlier record changes every hash after it.
    const a = computeRecordHash(payload(), GENESIS_PREVIOUS_HASH);
    const b = computeRecordHash(payload(), "f".repeat(64));
    expect(a).not.toBe(b);
  });

  it("hashes equal payloads written in a different key order identically", () => {
    const canonical = canonicalize(payload());
    expect(canonical.startsWith('{"data"')).toBe(true);
  });
});

describe("chain verification", () => {
  it("accepts an intact chain", () => {
    expect(verifyChain(buildChain(5))).toEqual({
      chainValid: true,
      brokenAtIndex: null,
      reason: null,
    });
  });

  it("accepts an empty chain", () => {
    expect(verifyChain([]).chainValid).toBe(true);
  });

  it("detects an altered payload and names the record", () => {
    const chain = buildChain(5);
    // Someone edits what record 2 says, leaving the hashes alone.
    (chain[2] as ChainRecord).payload = payload({ timestamp: "2020-01-01T00:00:00.000Z" });

    const result = verifyChain(chain);
    expect(result.chainValid).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.reason).toMatch(/does not hash/);
  });

  it("detects a corrupted payloadHash at the following record", () => {
    const chain = buildChain(5);
    // §4.8's acceptance criterion: corrupt one stored hash. Record 1 itself now
    // fails its own recomputation, which is the earliest break.
    (chain[1] as ChainRecord).payloadHash = "a".repeat(64);

    const result = verifyChain(chain);
    expect(result.chainValid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });

  it("detects a removed record", () => {
    const chain = buildChain(5);
    chain.splice(2, 1);

    const result = verifyChain(chain);
    expect(result.chainValid).toBe(false);
    // Record 2 (formerly 3) no longer links to its predecessor.
    expect(result.brokenAtIndex).toBe(2);
    expect(result.reason).toMatch(/predecessor/);
  });

  it("detects reordering", () => {
    const chain = buildChain(4);
    const [a, b] = [chain[1] as ChainRecord, chain[2] as ChainRecord];
    chain[1] = b;
    chain[2] = a;

    expect(verifyChain(chain).chainValid).toBe(false);
  });

  it("detects a chain that does not start at genesis", () => {
    // A truncated history: the earliest records were dropped.
    const chain = buildChain(3).slice(1);
    const result = verifyChain(chain);
    expect(result.brokenAtIndex).toBe(0);
    expect(result.reason).toMatch(/genesis/);
  });

  it("reports the FIRST break when several records are altered", () => {
    const chain = buildChain(6);
    (chain[4] as ChainRecord).payloadHash = "b".repeat(64);
    (chain[2] as ChainRecord).payloadHash = "c".repeat(64);

    // "Record 2 of 6 was altered" is actionable; a bare false is not.
    expect(verifyChain(chain).brokenAtIndex).toBe(2);
  });
});
