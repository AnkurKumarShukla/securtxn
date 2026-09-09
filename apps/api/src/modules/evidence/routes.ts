// Evidence chain endpoint.
// Spec: docs/architecture.md §4.8, §5

import { EvidenceChainResponse, Uuid } from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EvidenceService } from "./service.js";

const PaymentParams = z.object({ id: Uuid });

export const evidenceRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new EvidenceService(app.prisma);

  app.get(
    "/payments/:id/evidence",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["evidence"],
        summary: "Full evidence chain, verified on read",
        description:
          "Recomputes every hash from genesis rather than trusting a stored flag. " +
          "Reading this endpoint is itself recorded as an evidence_accessed event — " +
          "an unlogged read of an audit log is a gap.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: EvidenceChainResponse },
      },
    },
    async (request) => {
      const chain = await service.getChain(request.params.id);

      // After building the response: the caller sees the chain as it was when
      // they asked, not one containing the record describing their own read.
      await service.recordAccess({
        paymentRequestId: request.params.id,
        actorId: request.auth?.sub ?? "unknown",
        actorRole: request.auth?.role ?? "unknown",
      });

      return chain;
    },
  );
};
