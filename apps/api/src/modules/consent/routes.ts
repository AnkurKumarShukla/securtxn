// Payee consent, notifications and identity blocks (P3-P5).
//
// ROLES. Requesting consent is the SENDER's action and takes the agent role,
// like every other payment step. Deciding is the PAYEE's, and is authorised by
// the EIP-712 signature in the body rather than by the bearer token: the payee
// is a counterparty, not an operator of this platform, and issuing them an
// agent token so they could refuse a payment would hand them the rest of the
// API with it.
//
// Spec: docs/payment-flow.md (P3-P5)

import {
  BlockSummary,
  ConsentPrompt,
  CreateBlockRequest,
  NotificationSummary,
  PayeeConsentRequest,
  PayeeConsentResponse,
  RequestConsentResponse,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EvidenceService } from "../evidence/service.js";
import { ConsentService } from "./service.js";

const PaymentParams = z.object({ id: Uuid });
const VendorParams = z.object({ id: Uuid });

export const consentRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ConsentService({
    prisma: app.prisma,
    evidence: new EvidenceService(app.prisma),
    tierThresholds: app.container.tierThresholds,
    config: app.config,
  });

  app.post(
    "/payments/:id/request-consent",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["consent"],
        summary: "Ask the payee to accept this payment (P3)",
        description:
          "Nothing about the payee is verified until they agree to be verified. " +
          "This is what stops the identity match being a free lookup oracle.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: RequestConsentResponse },
      },
    },
    async (request) => service.request(request.params.id),
  );

  app.get(
    "/payments/:id/consent-prompt",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["consent"],
        summary: "What the payee is shown before deciding",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: ConsentPrompt },
      },
    },
    async (request) => service.prompt(request.params.id),
  );

  app.post(
    "/payments/:id/consent",
    {
      schema: {
        tags: ["consent"],
        summary: "The payee accepts or denies (P4)",
        description:
          "Unauthenticated by design: the EIP-712 signature from the confirmed " +
          "payout address IS the authorisation, and a payee is not an operator " +
          "of this platform. A denial carries no signature and needs none.",
        params: PaymentParams,
        body: PayeeConsentRequest,
        response: { 200: PayeeConsentResponse },
      },
    },
    async (request) => service.decide(request.params.id, request.body),
  );

  app.get(
    "/vendors/:id/notifications",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["consent"],
        summary: "Everything this vendor needs to see",
        description:
          "Consent requests, mismatch alerts and lock notices. A row, not an " +
          "email: it is testable and survives a delivery failure.",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        querystring: z.object({ unreadOnly: z.coerce.boolean().optional() }),
        response: { 200: z.array(NotificationSummary) },
      },
    },
    async (request) => {
      const rows = await app.prisma.notification.findMany({
        where: {
          vendorId: request.params.id,
          ...(request.query.unreadOnly ? { readAt: null } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        paymentRequestId: row.paymentRequestId,
        payload: row.payload as Record<string, unknown>,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  );

  app.post(
    "/vendors/:id/blocks",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["consent"],
        summary: "Refuse further payment requests from a payer (P3)",
        description:
          "Keyed on the payer's verified identity, never an address: addresses " +
          "rotate in seconds and a DigiLocker-backed identity does not.",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        body: CreateBlockRequest,
        response: { 201: BlockSummary },
      },
    },
    async (request, reply) => {
      const row = await app.prisma.identityBlock.upsert({
        where: {
          blockedByVendorId_blockedVendorId: {
            blockedByVendorId: request.params.id,
            blockedVendorId: request.body.blockedVendorId,
          },
        },
        // Idempotent: blocking someone already blocked is not an error, and a
        // 409 here would make a UI that cannot see the current state guess.
        update: { reason: request.body.reason ?? null },
        create: {
          blockedByVendorId: request.params.id,
          blockedVendorId: request.body.blockedVendorId,
          reason: request.body.reason ?? null,
        },
      });
      return reply.status(201).send({
        id: row.id,
        blockedByVendorId: row.blockedByVendorId,
        blockedVendorId: row.blockedVendorId,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      });
    },
  );

  app.delete(
    "/vendors/:id/blocks/:blockedVendorId",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["consent"],
        summary: "Unblock a payer",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: Uuid, blockedVendorId: Uuid }),
        // 200 with a count rather than a bare 204: unblocking someone who was
        // never blocked is not an error, and the count is how a caller tells
        // the two cases apart without a second request.
        response: { 200: z.object({ removed: z.number().int() }) },
      },
    },
    async (request, reply) => {
      const { count } = await app.prisma.identityBlock.deleteMany({
        where: {
          blockedByVendorId: request.params.id,
          blockedVendorId: request.params.blockedVendorId,
        },
      });
      return { removed: count };
    },
  );
};
