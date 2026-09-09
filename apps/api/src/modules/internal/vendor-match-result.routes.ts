// The return path for a CRE vendor-match verdict (D48).
//
// WHY THIS EXISTS: CRE's HTTP trigger is fire-and-forget. `workflows.execute`
// answers with an execution id and nothing else, and there is no API to read a
// workflow's return value — so a CRE workflow cannot be called as a synchronous
// "is this payee verified?" RPC. The workflow POSTs its verdict here instead,
// and the caller awaits the row.
//
// This suits the confidential design rather than fighting it: the verdict is
// precisely the one value that is supposed to leave the enclave. The vendor
// record never does.
//
// MUST BE IDEMPOTENT. In DON mode every observing node runs the handler and
// therefore every node POSTs the same verdict — the ngrok inspector shows five
// lookups per execution, so five callbacks arrive for one logical answer. In
// TEE mode exactly one arrives. Both are correct, so the second and later
// callbacks are accepted and ignored rather than treated as an error.
//
// Spec: docs/architecture.md §4.4, docs/decisions.md D48

import { Uuid } from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

/**
 * Either a verdict or a failure, never both and never neither.
 *
 * A failure is NOT a negative verdict. "We could not check" must never reach
 * the decision engine looking like "we checked and it failed" (D44), so it is
 * carried in a separate field and lands the row in FAILED, not COMPLETED.
 */
const Body = z.union([
  z.object({
    requestId: Uuid,
    match: z.boolean(),
    score: z.number().min(0).max(1),
    reasonCode: z.string().min(1).max(64),
  }),
  z.object({
    requestId: Uuid,
    failureReason: z.string().min(1).max(500),
  }),
]);

const Ack = z.object({ status: z.enum(["RECORDED", "ALREADY_RECORDED"]) });

export const vendorMatchResultRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/internal/vendor-match-result",
    {
      // The workflow authenticates with the Vault secret, which is an agent
      // token. Same posture as the lookup endpoint it already calls.
      preHandler: app.requireAnyRole("agent"),
      schema: {
        tags: ["internal"],
        summary: "Verdict callback from the CRE vendor-match workflow",
        description:
          "The CRE HTTP trigger is fire-and-forget, so the workflow returns its " +
          "verdict here instead. Idempotent: in DON mode one callback arrives per " +
          "observing node for a single logical verdict.",
        security: [{ bearerAuth: [] }],
        body: Body,
        response: { 200: Ack },
      },
    },
    async (request, reply) => {
      const body = request.body;

      // The row is created BEFORE the workflow is invoked, so an unknown
      // requestId is not a race — it is a callback nobody asked for. Rejecting
      // it is what stops this endpoint from being a way to inject a verdict
      // for a match that was never requested.
      const existing = await app.prisma.vendorMatchRequest.findUnique({
        where: { id: body.requestId },
      });

      if (!existing) return reply.callNotFound();

      if (existing.status !== "PENDING") {
        // Expected on every callback after the first. Logged at debug, not as
        // a warning: N-of-them is the normal shape of a DON execution.
        request.log.debug(
          { requestId: body.requestId, status: existing.status },
          "duplicate vendor-match callback ignored",
        );
        return { status: "ALREADY_RECORDED" as const };
      }

      if ("failureReason" in body) {
        await app.prisma.vendorMatchRequest.update({
          where: { id: body.requestId },
          data: {
            status: "FAILED",
            failureReason: body.failureReason,
            completedAt: new Date(),
          },
        });
        return { status: "RECORDED" as const };
      }

      await app.prisma.vendorMatchRequest.update({
        where: { id: body.requestId },
        data: {
          status: "COMPLETED",
          match: body.match,
          score: body.score,
          reasonCode: body.reasonCode,
          completedAt: new Date(),
        },
      });

      return { status: "RECORDED" as const };
    },
  );
};
