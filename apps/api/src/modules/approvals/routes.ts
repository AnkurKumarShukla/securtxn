// Approval queue endpoints.
//
// These are the ONLY routes an agent-scoped token must never reach. The
// separation is enforced by verifying against a different secret, so an agent
// token fails signature verification before any role string is compared (D12).
//
// Spec: docs/architecture.md §4.2, §4.3

import {
  CreateProposalRequest,
  PendingProposal,
  PendingProposalList,
  ReportSentRequest,
  ReportSentResponse,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EvidenceService } from "../evidence/service.js";
import { ApprovalService } from "./service.js";

const PaymentParams = z.object({ id: Uuid });
const ProposalParams = z.object({ id: Uuid });

export const approvalRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ApprovalService({
    prisma: app.prisma,
    evidence: new EvidenceService(app.prisma),
  });

  app.post(
    "/payments/:id/propose",
    {
      // Agent only. An approver token is rejected here, so the role that
      // approves cannot also queue work for itself.
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Queue a payment for human approval",
        description:
          "The furthest autonomous code can go. Writing a proposal is not approving " +
          "one, and only AWAITING_APPROVAL payments may be queued.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: CreateProposalRequest,
        response: { 201: PendingProposal },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await service.propose(
            request.params.id,
            request.auth?.sub ?? "unknown",
            request.body.selfieCheckProofRef,
          ),
        ),
  );

  app.get(
    "/approvals/pending",
    {
      // The human approver and the bridge daemon both legitimately read this;
      // each still verifies against its own secret.
      preHandler: app.requireAnyRole("approver", "bridge"),
      schema: {
        tags: ["approvals"],
        summary: "The approval queue",
        security: [{ bearerAuth: [] }],
        response: { 200: PendingProposalList },
      },
    },
    async () => ({ proposals: await service.listPending() }),
  );

  app.post(
    "/approvals/:id/report-sent",
    {
      preHandler: app.requireAnyRole("approver", "bridge"),
      schema: {
        tags: ["approvals"],
        summary: "Record a completed send",
        description:
          "Posted by the bridge after signing. The API never observes the signing " +
          "itself — it learns the outcome here.",
        security: [{ bearerAuth: [] }],
        params: ProposalParams,
        body: ReportSentRequest,
        response: { 200: ReportSentResponse },
      },
    },
    async (request) => service.reportSent(request.params.id, request.body),
  );
};
