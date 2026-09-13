// Vendor registry endpoints.
// Spec: docs/architecture.md §4.1

import {
  CreateVendorRequest,
  CreateVendorResponse,
  EvmAddress,
  Network,
  UpdateKybStatusRequest,
  Uuid,
  VendorByAddress,
  VendorList,
  VendorListQuery,
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
    "/vendors",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "List vendors — the payee directory",
        description:
          "Narrower than the per-vendor summary on purpose: a browsable list of " +
          "counterparties is the wrong place for identity details, so the Aadhaar " +
          "last-4 and the document checks stay on GET /vendors/:id. Carries the most " +
          "recent wallet's status, because that is what decides whether a vendor can " +
          "be paid at all. Keyset paged.",
        security: [{ bearerAuth: [] }],
        querystring: VendorListQuery,
        response: { 200: VendorList },
      },
    },
    async (request) => service.list(request.query),
  );

  /**
   * Registered BEFORE `/vendors/:id`.
   *
   * Fastify's radix router prefers a static segment over a parameter at the
   * same position, so ordering is not strictly load-bearing here — but `:id` is
   * typed as a Uuid, and relying on a validation failure to fall through to the
   * right route is the kind of thing that works until somebody relaxes the
   * type. Declaring the specific path first makes the intent obvious.
   */
  app.get(
    "/vendors/by-address/:address",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Which onboarding a payout address belongs to",
        description:
          "Session recovery. Everything a returning payee needs already exists server-side; " +
          "what a cleared browser loses is only the pointer to it. A connected wallet is a " +
          "better pointer, because it is the same one on every device. Includes wallets that " +
          "are still PENDING_VERIFICATION — somebody who got halfway and lost their storage " +
          "is precisely who needs to find their record, and refusing them makes them start a " +
          "second vendor for the same address. Use /internal/identity-registry when the " +
          "question is whether a transfer may proceed; that one fails closed.",
        security: [{ bearerAuth: [] }],
        params: z.object({ address: EvmAddress }),
        querystring: z.object({ network: Network.optional() }),
        response: { 200: VendorByAddress },
      },
    },
    async (request) => service.findByAddress(request.params.address, request.query.network),
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
