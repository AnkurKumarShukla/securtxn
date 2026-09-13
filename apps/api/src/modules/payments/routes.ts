// Payment endpoints.
// Spec: docs/architecture.md §4.1

import {
  AcknowledgmentRequest,
  AcknowledgmentResponse,
  CreatePaymentRequest,
  DecisionResult,
  PaymentList,
  PaymentListQuery,
  PaymentSummary,
  RecordClaimRequest,
  RecordLockRequest,
  RecordRefundRequest,
  RefundSweepResult,
  ReleaseSecretRequest,
  ReleaseSecretResponse,
  SettleRequest,
  SettleResponse,
  SettlementSummary,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EvidenceService } from "../evidence/service.js";
import { ExceptionService } from "../exceptions/service.js";
import { PaymentService } from "./service.js";
import { SettlementService } from "./settlement.js";
import { PaymentSettler } from "./settle.js";

const PaymentParams = z.object({ id: Uuid });

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  const evidenceService = new EvidenceService(app.prisma);
  const exceptionService = new ExceptionService({ prisma: app.prisma, evidence: evidenceService });
  const settlement = new SettlementService({
    prisma: app.prisma,
    evidence: evidenceService,
    exceptions: exceptionService,
  });
  const settler = new PaymentSettler({
    prisma: app.prisma,
    chain: app.container.chainGateway,
    evidence: evidenceService,
    exceptions: exceptionService,
    config: app.config,
  });
  const service = new PaymentService({
    prisma: app.prisma,
    compliance: app.container.complianceGateway,
    atsSecurityId: app.config.ATS_SECURITY_ID,
    vendorMatcher: app.container.vendorMatcher,
    sanctionsScreener: app.container.sanctionsScreener,
    tierThresholds: app.container.tierThresholds,
    evidence: evidenceService,
    exceptions: exceptionService,
    matcherKind: app.config.VENDOR_MATCHER,
    config: app.config,
  });

  app.get(
    "/payments",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "List payments",
        description:
          "Resolves the payee's display name at read time rather than storing it on " +
          "the row, so a renamed vendor does not leave stale names across history. " +
          "Keyset paged on (createdAt, id): payments are raised while the list is " +
          "being read, and an offset page would silently drop or repeat one.",
        security: [{ bearerAuth: [] }],
        querystring: PaymentListQuery,
        response: { 200: PaymentList },
      },
    },
    async (request) => service.list(request.query),
  );

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

  app.post(
    "/payments/:id/acknowledgment",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Record the recipient's signed acknowledgment of receipt",
        description:
          "Non-repudiation of receipt: the payee signs a commitment over the payment " +
          "context, so they cannot later claim it never arrived. The signature must " +
          "recover to the address the money was sent to. The raw context is stored " +
          "encrypted; only the commitment is ever anchored.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: AcknowledgmentRequest,
        response: { 201: AcknowledgmentResponse },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await service.acknowledge(request.params.id, request.body)),
  );

  // --- HTLC settlement ------------------------------------------------------
  //
  // Reporting routes, not signing routes. The bridge broadcasts every one of
  // these transactions and tells the API afterwards, which is why they are
  // agent-scoped: recording a fact is not authorising a payment (D12).

  app.post(
    "/payments/:id/settlement/lock",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Record an HTLC escrow the bridge has opened",
        description:
          "Only for payments raised with settlementMode HTLC, and only once the " +
          "payment has been sent — the lock transaction is the send. The lock id is " +
          "re-derived from the reported parameters and a mismatch is rejected, so " +
          "every stored escrow can be found again on chain.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: RecordLockRequest,
        response: { 201: SettlementSummary },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await settlement.recordLock(request.params.id, request.body)),
  );

  app.post(
    "/payments/:id/settlement/claim",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Record the payee claiming the escrow",
        description:
          "The preimage is checked against the stored hashlock before anything is " +
          "written. A valid claim also records the recipient acknowledgment: the payee " +
          "revealed a secret to collect the money, which is a receipt they cannot " +
          "repudiate and did not have to be asked for.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: RecordClaimRequest,
        response: { 200: SettlementSummary },
      },
    },
    async (request) => settlement.recordClaim(request.params.id, request.body),
  );

  app.post(
    "/payments/:id/settlement/refund",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Record an unclaimed escrow returning to the payer",
        description:
          "Refused before the timelock, because the contract refuses it too. The money " +
          "coming back is the good outcome, but a verified payee never collecting an " +
          "approved payment is not — so this also opens an exception case.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: RecordRefundRequest,
        response: { 200: SettlementSummary },
      },
    },
    async (request) => settlement.recordRefund(request.params.id, request.body),
  );

  app.post(
    "/payments/:id/settle",
    {
      preHandler: app.requireRole("approver"),
      schema: {
        tags: ["payments"],
        summary: "Release an approved payment",
        description:
          "The only route that spends. Approver-scoped, and refused unless the " +
          "payment is AWAITING_APPROVAL — an agent token cannot reach it. DIRECT " +
          "sends a transfer; HTLC generates a secret, publishes only its hash, and " +
          "opens an escrow the payee must claim before the timelock.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: SettleRequest,
        response: { 200: SettleResponse },
      },
    },
    async (request) =>
      settler.settle(request.params.id, request.body, request.auth?.sub ?? "unknown"),
  );

  app.post(
    "/payments/:id/settlement/secret",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Release the escrow secret to the payee",
        description:
          "Whoever holds the preimage can take the money, so a role token is not " +
          "enough. The payee signs an EIP-712 SecretRelease from the payout address " +
          "and the signature must recover to it. The lock id is in the payload, so a " +
          "signature captured for one escrow cannot open the next.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        body: ReleaseSecretRequest,
        response: { 200: ReleaseSecretResponse },
      },
    },
    async (request) => settler.releaseSecret(request.params.id, request.body),
  );

  app.post(
    "/payments/:id/settlement/refund/execute",
    {
      preHandler: app.requireRole("approver"),
      schema: {
        tags: ["payments"],
        summary: "Return one expired escrow to the payer",
        description:
          "The manual trigger on the refund sweep. Refused before the timelock, " +
          "because the contract refuses it too. Opens an exception case: a verified " +
          "payee who never collected an approved payment is something a human " +
          "should see.",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: SettlementSummary },
      },
    },
    async (request) => settler.executeRefund(request.params.id, request.auth?.sub ?? "unknown"),
  );

  app.post(
    "/settlement/sweep-refunds",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "Return every expired escrow to its payer",
        description:
          "The scheduled half of recovery. Without it a misdirected payment sits in " +
          "escrow until somebody remembers, which would make the product's central " +
          "promise depend on a person. One failure does not stop the sweep.",
        security: [{ bearerAuth: [] }],
        response: { 200: RefundSweepResult },
      },
    },
    async (request) => settler.sweepRefunds(request.auth?.sub ?? "unknown"),
  );

  app.get(
    "/payments/:id/settlement",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["payments"],
        summary: "The escrow backing this payment",
        security: [{ bearerAuth: [] }],
        params: PaymentParams,
        response: { 200: SettlementSummary },
      },
    },
    async (request) => settlement.get(request.params.id),
  );
};
