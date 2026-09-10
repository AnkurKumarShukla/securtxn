// World ID / Selfie Check routes (B4, §4.6, D49).
//
// WHAT SELFIE CHECK IS USED FOR HERE, precisely: a continuity and
// anti-automation signal on the human approving a payment. It proves a live
// human is present AND that it is the same human who enrolled — it does NOT
// prove *which* human. Selfie Check is medium assurance and explicitly not
// one-person-one-account, so beneficiary identity stays with DigiLocker plus
// the EIP-712 wallet-control signature (§4.7, D02) and is not weakened by
// anything here.
//
// Two operations, and the order matters:
//   POST /world-id/enroll  — records the nullifier once, at onboarding. This is
//                            the value every later check is measured against.
//   POST /world-id/verify  — proves the human acting now is that same human.
//
// Both persist the proof before answering, so a replay is rejected by the
// database rather than by trusting the World verifier — which returns
// success:true on a reused nullifier (D49a).

import { Uuid } from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, BadRequestError, ConflictError, ForbiddenError } from "../../lib/errors.js";
import {
  DifferentHumanError,
  NotEnrolledError,
  NullifierReplayError,
  SignalMismatchError,
} from "./service.js";
import type { IdKitProof as IdKitProofType } from "./WorldIdProofVerifier.js";
import { WorldIdVerificationError } from "./WorldIdProofVerifier.js";

/**
 * The IDKit result, forwarded as-is.
 *
 * Deliberately permissive: re-encoding or trimming any field invalidates the
 * signature over it, so this validates the envelope and passes the rest
 * through untouched.
 */
const IdKitProof = z
  .object({
    action: z.string().optional(),
    environment: z.string().optional(),
    protocol_version: z.string().optional(),
    responses: z
      .array(
        z
          .object({
            identifier: z.string().optional(),
            nullifier: z.string().optional(),
            signal_hash: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const Body = z.object({
  proof: IdKitProof,
  /**
   * What the proof must be bound to — the onboarding session for an enrolment,
   * the proposal id for a re-verification. Checked against the proof's
   * signal_hash, because the v4 verifier is never told what we expected (D49b).
   */
  signal: z.string().min(1).max(200),
  /** Whose continuity this is: a vendor id, an approver subject. */
  subject: z.string().min(1).max(200),
});

const Accepted = z.object({
  verificationId: Uuid,
  credential: z.string(),
  purpose: z.enum(["ENROLLMENT", "REVERIFICATION"]),
  /** True when World flagged the nullifier as seen before. Diagnostic only. */
  upstreamReuse: z.boolean(),
});

export const worldIdRoutes: FastifyPluginAsyncZod = async (app) => {

  /**
   * Translates domain failures into the codebase's error vocabulary.
   *
   * Every branch here is a REFUSAL, and each says something different. Folding
   * them into one generic 400 would lose the distinction between "this is a
   * different person" and "this proof was already used" — exactly what an
   * operator needs in a dispute.
   */
  function refuse(error: unknown): never {
    if (error instanceof SignalMismatchError) throw new BadRequestError(error.message);
    if (error instanceof WorldIdVerificationError) throw new BadRequestError(error.message);
    if (error instanceof NullifierReplayError) throw new ConflictError(error.message);
    if (error instanceof NotEnrolledError) throw new ConflictError(error.message);
    if (error instanceof DifferentHumanError) throw new ForbiddenError(error.message);
    throw error;
  }

  for (const [path, purpose, summary] of [
    [
      "/world-id/enroll",
      "ENROLLMENT",
      "Record the approver's World ID at onboarding",
    ],
    [
      "/world-id/verify",
      "REVERIFICATION",
      "Prove the human acting now is the one who enrolled",
    ],
  ] as const) {
    app.post(
      path,
      {
        preHandler: app.requireAnyRole("agent", "approver"),
        schema: {
          tags: ["world-id"],
          summary,
          description:
            purpose === "ENROLLMENT"
              ? "Verifies a Selfie Check proof and stores its nullifier as the enrolment " +
                "for this subject. The nullifier is stable per person, so this becomes the " +
                "value every later continuity check is compared against."
              : "Verifies a Selfie Check proof and requires its nullifier to match the " +
                "subject's enrolment. A valid proof from a DIFFERENT human is refused, and " +
                "a subject with no enrolment fails closed.",
          security: [{ bearerAuth: [] }],
          body: Body,
          response: { 200: Accepted },
        },
      },
      async (request) => {
        // Resolved per request, not captured at registration: the container is
        // decorated while the server readies, so a value read here is the one
        // actually in effect — and it stays swappable for tests.
        const service = request.server.container.worldId;

        if (!service) {
          // Fails closed and says so. A disabled control must never be
          // indistinguishable from a passing one.
          throw new AppError(
            503,
            "WORLD_ID_DISABLED",
            "World ID is not enabled: set WORLD_FEATURE_FLAG_ENABLED=true and WORLD_RP_ID",
          );
        }

        try {
          const accepted = await service.accept({
            // Zod's passthrough output is structurally the IDKit result; the
            // cast keeps the proof bytes untouched, which is the one thing that
            // must not change (re-encoding invalidates the signature).
            proof: request.body.proof as unknown as IdKitProofType,
            signal: request.body.signal,
            subject: request.body.subject,
            purpose,
          });

          return {
            verificationId: accepted.id,
            credential: accepted.credential,
            purpose: accepted.purpose,
            upstreamReuse: accepted.upstreamReuse,
          };
        } catch (error) {
          request.log.warn(
            { subject: request.body.subject, purpose },
            "world id verification refused",
          );
          refuse(error);
        }
      },
    );
  }
};
