// World ID verification service (B4, §4.6, D49/D49a).
//
// Two jobs, deliberately separate:
//   1. ENROLLMENT   — record the nullifier at onboarding. This is the value
//                     every later check is compared against.
//   2. REVERIFICATION — prove the human acting now is the same one who
//                     enrolled, by comparing nullifiers.
//
// What this module does NOT do: identify anyone. A nullifier is pseudonymous
// and RP-scoped. Selfie Check is medium assurance and explicitly not
// one-person-one-account, so this proves "same human as before, alive right
// now" — not WHO. Beneficiary identity rests on DigiLocker plus the EIP-712
// wallet-control signature (§4.7, D02), and nothing here weakens or replaces it.

import { Prisma, type PrismaClient, type WorldIdPurpose } from "@prisma/client";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { nullifierToDecimal } from "./nullifier.js";
import {
  type IdKitProof,
  type WorldIdProofVerifier,
} from "./WorldIdProofVerifier.js";

export class SignalMismatchError extends Error {
  constructor(readonly expected: string) {
    super(`the proof is not bound to the expected signal "${expected}"`);
    this.name = "SignalMismatchError";
  }
}

export class NullifierReplayError extends Error {
  constructor(readonly action: string, readonly signal: string) {
    super(`this World ID proof has already been used for signal "${signal}"`);
    this.name = "NullifierReplayError";
  }
}

export class NotEnrolledError extends Error {
  constructor(readonly subject: string) {
    super(`no World ID enrollment on file for subject "${subject}"`);
    this.name = "NotEnrolledError";
  }
}

export class DifferentHumanError extends Error {
  constructor(readonly subject: string) {
    super(`the World ID that verified is not the one enrolled for subject "${subject}"`);
    this.name = "DifferentHumanError";
  }
}

export type AcceptProofInput = {
  proof: IdKitProof;
  /** Must match the signal the proof was requested with. */
  signal: string;
  subject: string;
  purpose: WorldIdPurpose;
};

export type AcceptedProof = {
  id: string;
  nullifier: string;
  credential: string;
  action: string;
  purpose: WorldIdPurpose;
  upstreamReuse: boolean;
};

export type WorldIdServiceOptions = {
  prisma: PrismaClient;
  verifier: WorldIdProofVerifier;
  /**
   * The action every proof must carry. Constant by design: the nullifier is
   * action-scoped, so enrollment and every later check MUST use the same string
   * or the same human yields different nullifiers and continuity breaks
   * silently — which would look like fraud detection working (D49).
   */
  expectedAction: string;
};

export class WorldIdService {
  constructor(private readonly options: WorldIdServiceOptions) {}

  /**
   * Verifies a proof upstream, then records it. Rejects a replay.
   *
   * For REVERIFICATION the recorded nullifier is also checked against the
   * subject's enrollment, so a valid proof from a DIFFERENT human is refused
   * rather than accepted just because it verified.
   */
  async accept(input: AcceptProofInput): Promise<AcceptedProof> {
    const verified = await this.options.verifier.verify(input.proof);

    // A proof for a different action is a different nullifier space. Accepting
    // it would silently store a value that can never match the enrollment.
    if (verified.action !== this.options.expectedAction) {
      throw new Error(
        `proof carries action "${verified.action}", expected "${this.options.expectedAction}"`,
      );
    }

    // THE BINDING CHECK, and it has to happen here.
    //
    // The v4 verify endpoint is never told which signal we expected, so a
    // successful upstream verification only means "valid for whatever signal is
    // inside this proof". Without this comparison a caller could present a
    // genuine, correctly-signed proof bound to some other context — or to the
    // empty signal, which is what an unbound request produces — and we would
    // record it as authorising THIS payment. That is the whole value of the
    // signal (D49b).
    if (verified.signalHash !== hashSignal(input.signal)) {
      throw new SignalMismatchError(input.signal);
    }

    const nullifier = nullifierToDecimal(verified.nullifierHex);

    if (input.purpose === "REVERIFICATION") {
      await this.assertSameHuman(input.subject, nullifier);
    }

    try {
      const row = await this.options.prisma.worldIdVerification.create({
        data: {
          nullifier: new Prisma.Decimal(nullifier),
          action: verified.action,
          signal: input.signal,
          credential: verified.credential,
          environment: verified.environment,
          subject: input.subject,
          purpose: input.purpose,
          upstreamReuse: verified.upstreamReuse,
        },
        select: { id: true },
      });

      return {
        id: row.id,
        nullifier,
        credential: verified.credential,
        action: verified.action,
        purpose: input.purpose,
        upstreamReuse: verified.upstreamReuse,
      };
    } catch (error) {
      // P2002 = unique violation on (nullifier, action, signal). THIS is the
      // replay control — not the upstream response, which returns success:true
      // on a reused nullifier (D49a).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new NullifierReplayError(verified.action, input.signal);
      }
      throw error;
    }
  }

  /** The enrollment a subject's later proofs are measured against. */
  async enrollmentOf(subject: string): Promise<string | null> {
    const row = await this.options.prisma.worldIdVerification.findFirst({
      where: { subject, purpose: "ENROLLMENT" },
      orderBy: { verifiedAt: "asc" },
      select: { nullifier: true },
    });
    return row ? row.nullifier.toFixed(0) : null;
  }

  /**
   * Fails closed: an absent enrollment raises rather than passing. "We have
   * nothing to compare against" must never read as "the check passed".
   */
  async assertSameHuman(subject: string, nullifier: string): Promise<void> {
    const enrolled = await this.enrollmentOf(subject);

    if (enrolled === null) throw new NotEnrolledError(subject);
    // Both sides are canonical decimal, so this is an exact integer comparison
    // and not subject to the hex-padding hazard in nullifier.ts (D49a).
    if (enrolled !== nullifier) throw new DifferentHumanError(subject);
  }
}
