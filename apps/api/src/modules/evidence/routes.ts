// Evidence chain endpoint.
// Spec: docs/architecture.md §4.8, §5

import {
  AnchorRunResult,
  AnchorSummary,
  EvidenceChainResponse,
  InclusionProof,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AnchorService } from "./anchor.js";
import { EvidenceService } from "./service.js";

const PaymentParams = z.object({ id: Uuid });
const RecordParams = z.object({ id: Uuid });

export const evidenceRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new EvidenceService(app.prisma);
  const anchors = new AnchorService({
    prisma: app.prisma,
    gateway: app.container.anchorGateway,
  });

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

  // --- consensus anchoring (§4.8, D19) --------------------------------------

  app.post(
    "/evidence/anchor",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["evidence"],
        summary: "Publish a Merkle root over every unanchored record",
        description:
          "The hash chain proves nobody edited a record without editing every later " +
          "one. It cannot prove we did not rewrite the whole chain, because we own the " +
          "database. A root on a public consensus topic can. Called on a schedule; an " +
          "empty batch is a normal success.",
        security: [{ bearerAuth: [] }],
        response: { 200: AnchorRunResult },
      },
    },
    async () => anchors.run(),
  );

  app.get(
    "/evidence/anchors",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["evidence"],
        summary: "Published anchors, newest first",
        security: [{ bearerAuth: [] }],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.array(AnchorSummary) },
      },
    },
    async (request) => anchors.list(request.query.limit),
  );

  app.post(
    "/evidence/anchors/:id/verify",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["evidence"],
        summary: "Confirm a mirror node is serving this anchor back",
        description:
          "Anchoring is not finished when we submit it, but when a third party can read " +
          "it and the root they read matches ours. Returns 409 while the message is " +
          "still propagating, which takes a few seconds.",
        security: [{ bearerAuth: [] }],
        params: RecordParams,
        response: { 200: AnchorSummary },
      },
    },
    async (request) => anchors.verify(request.params.id),
  );

  app.get(
    "/evidence/records/:id/proof",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["evidence"],
        summary: "Inclusion proof for one evidence record",
        description:
          "Self-contained: the leaf, its siblings, the root, and the public mirror-node " +
          "URL of the message that root was published in. Verifying it needs keccak256 " +
          "and nothing from this system, which is the entire point.",
        security: [{ bearerAuth: [] }],
        params: RecordParams,
        response: { 200: InclusionProof },
      },
    },
    async (request) => anchors.proofFor(request.params.id),
  );
};