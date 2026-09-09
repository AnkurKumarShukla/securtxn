// Vendor registry endpoints.
// Spec: docs/architecture.md §4.1

import {
  CreateVendorRequest,
  CreateVendorResponse,
  UpdateKybStatusRequest,
  Uuid,
  VendorSummary,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { VendorService } from "./service.js";

const VendorParams = z.object({ id: Uuid });

export const vendorRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new VendorService({ prisma: app.prisma, config: app.config });

  app.post(
    "/vendors",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Create a vendor and issue its onboarding nonce",
        description:
          "The nonce is generated server-side and must be carried unchanged into the " +
          "identity session, the liveness capture and the wallet signature. Differing " +
          "nonces mean the artifacts may belong to different people.",
        security: [{ bearerAuth: [] }],
        body: CreateVendorRequest,
        response: { 201: CreateVendorResponse },
      },
    },
    async (request, reply) => reply.status(201).send(await service.create(request.body)),
  );

  app.get(
    "/vendors/:id",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Vendor summary — no raw PII",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        response: { 200: VendorSummary },
      },
    },
    async (request) => service.get(request.params.id),
  );

  app.patch(
    "/vendors/:id/kyb-status",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Mark KYB VERIFIED / REJECTED (manual for MVP)",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        body: UpdateKybStatusRequest,
        response: { 200: VendorSummary },
      },
    },
    async (request) => service.updateKybStatus(request.params.id, request.body.kybStatus),
  );
};
