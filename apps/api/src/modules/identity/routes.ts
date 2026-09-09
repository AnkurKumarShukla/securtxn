// Identity endpoints.
//
// Spec: docs/architecture.md §4.1

import {
  CompleteIdentityResponse,
  IdentitySessionStatusResponse,
  StartIdentitySessionRequest,
  StartIdentitySessionResponse,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { IdentityService } from "./service.js";

const VendorParams = z.object({ id: Uuid });

const StartSessionResponse = StartIdentitySessionResponse.extend({
  /** Echoed so the caller can carry it into the liveness and wallet steps (D03). */
  onboardingSessionNonce: z.string(),
});

export const identityRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new IdentityService({
    prisma: app.prisma,
    provider: app.container.identityProvider,
    config: app.config,
  });

  app.post(
    "/vendors/:id/identity/session",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["identity"],
        summary: "Start an identity session",
        description:
          "Returns an authorizationUrl the HUMAN must open and consent at. This step " +
          "cannot be automated, and that is what makes DigiLocker defensible as an " +
          "identity source. In mock mode the URL points at a local consent stub.",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        body: StartIdentitySessionRequest,
        response: { 200: StartSessionResponse },
      },
    },
    async (request) => {
      const { mobile, docTypes } = request.body;
      return service.startSession(request.params.id, {
        ...(mobile ? { mobile } : {}),
        docTypes,
      });
    },
  );

  app.get(
    "/vendors/:id/identity/status",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["identity"],
        summary: "Poll session status",
        description: "created → succeeded once the human has consented. Not billable.",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        response: { 200: IdentitySessionStatusResponse },
      },
    },
    async (request) => {
      const status = await service.getStatus(request.params.id);
      return IdentitySessionStatusResponse.parse(status);
    },
  );

  app.post(
    "/vendors/:id/identity/complete",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["identity"],
        summary: "Fetch documents, run all four checks, persist on a clean pass",
        description:
          "Runs XMLDSig verification, cross-document consistency, same-subject linkage " +
          "and TTL capture. Returns 422 and persists nothing if any check fails — an " +
          "unverified identity is never stored as usable.",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        response: { 200: CompleteIdentityResponse },
      },
    },
    async (request) => service.complete(request.params.id),
  );
};
