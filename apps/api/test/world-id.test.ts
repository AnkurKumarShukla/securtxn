// World ID module (B4, §4.6, D49/D49a/D49b).
//
// Driven off the two REAL sandbox captures in fixtures/worldid/, so these tests
// exercise the payload shapes World actually returns rather than shapes I
// imagined. The two captures are the same human verifying the same action
// twice, which is exactly the continuity case the design rests on.
//
// The emphasis is on what the module must REFUSE. A verifier that accepts
// everything passes a happy-path test and protects nothing — and World's own
// endpoint returns success:true on a replayed nullifier, so every rejection
// below is ours to enforce.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { nullifierToDecimal } from "../src/modules/worldid/nullifier.js";
import {
  DifferentHumanError,
  NotEnrolledError,
  NullifierReplayError,
  SignalMismatchError,
  WorldIdService,
} from "../src/modules/worldid/service.js";
import type {
  IdKitProof,
  WorldIdProofVerifier,
} from "../src/modules/worldid/WorldIdProofVerifier.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "worldid");
const read = (file: string) => JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));

const first = read("01_selfie_check_first.json");
const reuse = read("02_selfie_check_reuse.json");
const oracle = read("index.json").expected_check_results;

const ACTION = "verify-payment-approver";

/** The captures were taken with an EMPTY signal — anything else is a mismatch. */
const CAPTURED_SIGNAL = "";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

/** Replays a recorded upstream response. Never touches the network. */
function verifierFor(capture: { upstream: Record<string, never> }): WorldIdProofVerifier {
  const response = capture.upstream as unknown as {
    nullifier: string;
    action: string;
    environment: string;
    message: string;
    results: { identifier: string }[];
  };

  return {
    async verify(proof: IdKitProof) {
      return {
        nullifierHex: response.nullifier,
        signalHash: proof.responses?.[0]?.signal_hash ?? "",
        credential: response.results[0]!.identifier,
        action: response.action,
        environment: response.environment,
        upstreamReuse: /nullifier reuse/i.test(response.message),
      };
    },
  };
}

function serviceFor(capture: unknown) {
  return new WorldIdService({
    prisma,
    verifier: verifierFor(capture as { upstream: Record<string, never> }),
    expectedAction: ACTION,
  });
}

let seq = 0;
const subjects: string[] = [];
function newSubject() {
  const subject = `worldid-test-${Date.now()}-${seq++}`;
  subjects.push(subject);
  return subject;
}

/**
 * A copy of a capture's proof rebound to a given signal.
 *
 * Both captures were taken with an EMPTY signal. Real signals are per-subject
 * (an onboarding session nonce) or per-event (a proposal id), and the unique
 * index is deliberately `(nullifier, action, signal)` with NO subject — so one
 * human genuinely cannot reuse one proof under two identities. Tests therefore
 * use distinct signals, exactly as production would; sharing the empty signal
 * across subjects would collide for reasons that say nothing about the code.
 */
function boundProof(capture: { idkit: unknown }, signal: string) {
  const proof = structuredClone(capture.idkit) as {
    responses: { signal_hash: string }[];
  };
  proof.responses[0]!.signal_hash = hashSignal(signal);
  return proof;
}

/** The signal a subject enrolls under. Unique per subject, as in production. */
const enrollSignal = (subject: string) => `${subject}:enroll`;

const proofBoundTo = (signal: string) => boundProof(first, signal);

afterAll(async () => {
  await prisma.worldIdVerification.deleteMany({ where: { subject: { in: subjects } } });
  await prisma.$disconnect();
});

describe("nullifier normalisation (D49a)", () => {
  it("converts the captured nullifier to the decimal the oracle records", () => {
    expect(nullifierToDecimal(oracle.nullifier_hex)).toBe(oracle.nullifier_decimal);
  });

  it("treats a leading-zero-stripped nullifier as the SAME value", () => {
    // The trap this design guards against. Field elements come back as unpadded
    // hex — an observed merkle_root was 63 chars in one run and 64 in the next.
    // Stored as text these are two different people; as decimals they are one,
    // which is what makes both replay detection and continuity correct.
    expect(nullifierToDecimal("0x0abc")).toBe(nullifierToDecimal("0xabc"));
  });

  it("is case-insensitive, since hex casing is not identity", () => {
    expect(nullifierToDecimal("0xABCDEF")).toBe(nullifierToDecimal("0xabcdef"));
  });

  it.each(["", "abc", "0x", "0xZZ", "1234"])(
    "rejects malformed nullifier %j rather than coercing it",
    (bad) => {
      // Coercing to 0 or NaN would poison the unique index and silently break
      // every later comparison.
      expect(() => nullifierToDecimal(bad)).toThrow();
    },
  );

  it("rejects a value wider than 256 bits", () => {
    expect(() => nullifierToDecimal(`0x${"f".repeat(65)}`)).toThrow();
  });

  it("does not echo the full identifier in its error message", () => {
    expect(() => nullifierToDecimal(`0xZZ${"a".repeat(80)}`)).toThrow(/…/);
  });
});

describe("accepting a proof", () => {
  it("records an enrollment from the real capture", async () => {
    const subject = newSubject();
    const accepted = await serviceFor(first).accept({
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT",
    });

    expect(accepted.credential).toBe("selfie");
    expect(accepted.nullifier).toBe(oracle.nullifier_decimal);
    expect(accepted.upstreamReuse).toBe(false);

    const row = await prisma.worldIdVerification.findUniqueOrThrow({ where: { id: accepted.id } });
    expect(row.nullifier.toFixed(0)).toBe(oracle.nullifier_decimal);
    expect(row.purpose).toBe("ENROLLMENT");
  });

  it("stores OUR verification time, not upstream's created_at (D49a)", async () => {
    // Both captures carry an identical upstream created_at hours apart — it is
    // when the nullifier was first ever seen. Persisting it would put a wrong
    // timestamp in the evidence chain.
    const subject = newSubject();
    const before = Date.now();
    const accepted = await serviceFor(first).accept({
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT",
    });

    const row = await prisma.worldIdVerification.findUniqueOrThrow({ where: { id: accepted.id } });
    expect(row.verifiedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.verifiedAt.toISOString()).not.toContain("2026-09-09T22:15:54");
  });

  it("refuses a proof bound to a different signal than the one claimed", async () => {
    // THE BINDING CHECK. The v4 verify endpoint is never told which signal we
    // expected, so without this a genuine proof bound to anything else — or to
    // nothing, as these captures are — would be recorded as authorising this
    // specific action (D49b).
    const subject = newSubject();

    await expect(
      serviceFor(first).accept({
        proof: first.idkit,
        signal: "proposal-that-was-never-signed",
        subject,
        purpose: "ENROLLMENT",
      }),
    ).rejects.toBeInstanceOf(SignalMismatchError);

    expect(await prisma.worldIdVerification.count({ where: { subject } })).toBe(0);
  });

  it("refuses a proof carrying an unexpected action", async () => {
    // A different action is a different nullifier space; storing it would save a
    // value that can never match the enrollment.
    const subject = newSubject();
    const service = new WorldIdService({
      prisma,
      verifier: verifierFor(first as { upstream: Record<string, never> }),
      expectedAction: "some-other-action",
    });

    await expect(
      service.accept({
        proof: first.idkit,
        signal: CAPTURED_SIGNAL,
        subject,
        purpose: "ENROLLMENT",
      }),
    ).rejects.toThrow(/expected "some-other-action"/);
  });
});

describe("replay protection — World returns success on reuse, so this is ours (D49a)", () => {
  it("rejects the same nullifier twice for the same signal", async () => {
    const subject = newSubject();
    const service = serviceFor(first);
    const input = {
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT" as const,
    };

    await service.accept(input);
    await expect(service.accept(input)).rejects.toBeInstanceOf(NullifierReplayError);

    expect(await prisma.worldIdVerification.count({ where: { subject } })).toBe(1);
  });

  it("rejects the REAL second capture, which upstream approved", async () => {
    // Capture 02 is a genuinely fresh proof that World verified successfully
    // while annotating "(nullifier reuse)". Upstream success is not sufficient.
    const subject = newSubject();
    await serviceFor(first).accept({
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT",
    });

    await expect(
      serviceFor(reuse).accept({
        proof: boundProof(reuse, enrollSignal(subject)),
        signal: enrollSignal(subject),
        subject,
        purpose: "REVERIFICATION",
      }),
    ).rejects.toBeInstanceOf(NullifierReplayError);
  });

  it("allows the same human to verify again for a DIFFERENT signal", async () => {
    // The point of scoping uniqueness to the signal rather than the action: one
    // approver must be able to approve many payments, just never one twice.
    // World's documented UNIQUE(nullifier, action) would break this (D49).
    const subject = newSubject();
    const service = serviceFor(first);

    await service.accept({
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT",
    });

    await expect(
      service.accept({
        proof: proofBoundTo(`${subject}:p2`),
        signal: `${subject}:p2`,
        subject,
        purpose: "REVERIFICATION",
      }),
    ).resolves.toMatchObject({ nullifier: oracle.nullifier_decimal });

    expect(await prisma.worldIdVerification.count({ where: { subject } })).toBe(2);
  });
});

describe("continuity — same human as at onboarding", () => {
  it("accepts a later proof whose nullifier matches the enrollment", async () => {
    const subject = newSubject();
    const service = serviceFor(first);
    await service.accept({
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT",
    });

    await expect(
      service.accept({
        proof: proofBoundTo(`${subject}:p9`),
        signal: `${subject}:p9`,
        subject,
        purpose: "REVERIFICATION",
      }),
    ).resolves.toMatchObject({ purpose: "REVERIFICATION" });
  });

  it("rejects a valid proof from a DIFFERENT human", async () => {
    // The proof verifies perfectly — it is simply not the person who onboarded.
    // Accepting it because upstream said success is the failure this guards.
    const subject = newSubject();
    await serviceFor(first).accept({
      proof: boundProof(first, enrollSignal(subject)),
      signal: enrollSignal(subject),
      subject,
      purpose: "ENROLLMENT",
    });

    const stranger = structuredClone(first);
    const other = `0x${"deadbeef".repeat(8)}`;
    stranger.upstream.nullifier = other;
    stranger.upstream.results[0].nullifier = other;

    await expect(
      serviceFor(stranger).accept({
        proof: proofBoundTo(`${subject}:p3`),
        signal: `${subject}:p3`,
        subject,
        purpose: "REVERIFICATION",
      }),
    ).rejects.toBeInstanceOf(DifferentHumanError);
  });

  it("fails closed when the subject never enrolled", async () => {
    // "Nothing to compare against" must never read as "the check passed".
    await expect(
      serviceFor(first).accept({
        proof: proofBoundTo("proposal-4"),
        signal: "proposal-4",
        subject: newSubject(),
        purpose: "REVERIFICATION",
      }),
    ).rejects.toBeInstanceOf(NotEnrolledError);
  });

  it("does not let one subject's enrollment satisfy another's continuity", async () => {
    const enrolled = newSubject();
    const other = newSubject();
    await serviceFor(first).accept({
      proof: boundProof(first, enrollSignal(enrolled)),
      signal: enrollSignal(enrolled),
      subject: enrolled,
      purpose: "ENROLLMENT",
    });

    await expect(
      serviceFor(first).accept({
        proof: proofBoundTo(`${other}:p5`),
        signal: `${other}:p5`,
        subject: other,
        purpose: "REVERIFICATION",
      }),
    ).rejects.toBeInstanceOf(NotEnrolledError);
  });
});
