// Payment endpoints.
// Spec: docs/architecture.md §4.1

import {
  CreatePaymentRequest,
  DecisionResult,
  PaymentSummary,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EvidenceService } from "../evidence/service.js";
import { PaymentService } from "./service.js";

const PaymentParams = z.object({ id: Uuid });

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new PaymentService({
    prisma: app.prisma,
    vendorMatcher: app.container.vendorMatcher,
    sanctionsScreener: app.container.sanctionsScreener,
    tierThresholds: app.container.tierThresholds,
    evidence: new EvidenceService(app.prisma),
    matcherKind: app.config.VENDOR_MATCHER,
  });

  app.post(
    "/payments",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Create a payment request",
        description:
          "Names an exact wallet VERSION, not just a vendor: a rotation between " +
          "decision and send would otherwise redirect the money.",
        security: [{ bearerAuth: [] }],
        body: CreatePaymentRequest,
        response: { 201: PaymentSummary },
      },
    },
    async (request, reply) => reply.status(201).send(await service.create(request.body)),
  );

  app.post(
    "/payments/:id/run-decision",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Run vendor match + sanctions screen + the decision engine",
        description:
          "Only SAFE_TO_SEND and SEND_TEST_AMOUNT advance to AWAITING_APPROVAL. " +
          "DO_NOT_SEND and REVERIFY stay at DECISION_PENDING so a human sees them.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: DecisionResult },
      },
    },
    async (request) => service.runDecision(request.params.id),
  );

  app.get(
    "/payments/:id",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Payment state including the decision",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: PaymentSummary },
      },
    },
    async (request) => service.get(request.params.id),
  );
};
