// Issuance and lifecycle endpoints.
//
// ISSUER-SCOPED, every one of them. Creating an instrument and minting units
// are not payment operations: an agent token proposes payments and an approver
// token releases them, and neither should be able to conjure new value. The
// separation is structural — each role verifies against its own secret (D12).
//
// The sweep is the one exception, and it is agent-scoped because a scheduler
// calls it. It only ends instruments that have already matured, which is not a
// discretionary act.
//
// Spec: docs/architecture.md §4.5

import {
  ChainOperationResult,
  IssueSecurityRequest,
  MintRequest,
  RedeemRequest,
  SecurityEventSummary,
  SecurityHolding,
  SecuritySummary,
  SetCouponRequest,
  UpdateMaturityRequest,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SecurityService } from "./service.js";

const SecurityParams = z.object({ id: Uuid });

const SweepResult = z.object({
  securitiesConsidered: z.number().int(),
  redeemed: z.array(
    z.object({
      securityId: Uuid,
      holder: z.string(),
      amount: z.string(),
      txHash: z.string(),
    }),
  ),
  /** Reported, never swallowed: a holding that could not be unwound is a task. */
  failed: z.array(z.object({ securityId: Uuid, holder: z.string(), reason: z.string() })),
});

export const securityRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new SecurityService({
    prisma: app.prisma,
    chain: app.container.chainGateway,
  });

  const actor = (request: { auth?: { sub: string } }) => request.auth?.sub ?? "unknown";

  app.post(
    "/securities",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Issue a tokenized receivable",
        description:
          "Deploys a bond through the ATS factory and registers this platform as a " +
          "credential issuer the token trusts, in one call. Without that second step " +
          "every later KYC grant against the security reverts. Omit the ISIN and a " +
          "valid one is generated — the factory rejects a bad check digit.",
        security: [{ bearerAuth: [] }],
        body: IssueSecurityRequest,
        response: { 201: SecuritySummary },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await service.issue(request.body, actor(request))),
  );

  app.get(
    "/securities",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Every issued security, newest first",
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(SecuritySummary) },
      },
    },
    async () => service.list(),
  );

  app.get(
    "/securities/:id",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "One security",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        response: { 200: SecuritySummary },
      },
    },
    async (request) => service.get(request.params.id),
  );

  app.get(
    "/securities/:id/events",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Lifecycle history",
        description:
          "Append-only, in causal order: issuance, preparation, mints, coupons, " +
          "maturity changes and redemptions, each with the transaction that did it.",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        response: { 200: z.array(SecurityEventSummary) },
      },
    },
    async (request) => service.events(request.params.id),
  );

  app.get(
    "/securities/:id/holdings",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Balances held by confirmed wallets",
        description:
          "Read from chain, not from a local ledger. Only wallets this platform " +
          "confirmed are listed; a holder it never verified is not its business.",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        response: { 200: z.array(SecurityHolding) },
      },
    },
    async (request) => service.holdings(request.params.id),
  );

  app.post(
    "/securities/:id/mint",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Mint units to a confirmed vendor wallet",
        description:
          "The holder is named by wallet id, never by raw address: minting anywhere " +
          "would route value past the confirmation pipeline. Amounts are human " +
          "decimals and are scaled by the token's own decimals, read from chain.",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        body: MintRequest,
        response: { 201: ChainOperationResult },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await service.mint(request.params.id, request.body, actor(request))),
  );

  app.post(
    "/securities/:id/coupon",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Schedule a coupon",
        description:
          "The corporate action that makes this a bond rather than a token with a " +
          "name. Refused when the execution date falls past maturity, which the " +
          "contract also refuses but less legibly.",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        body: SetCouponRequest,
        response: { 201: ChainOperationResult },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(await service.setCoupon(request.params.id, request.body, actor(request))),
  );

  app.patch(
    "/securities/:id/maturity",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Move the maturity date",
        description:
          "Checked against chain time, not this server's clock, because that is what " +
          "the contract compares against. Settling a receivable early is an ordinary " +
          "event; the date must still be in the future.",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        body: UpdateMaturityRequest,
        response: { 200: ChainOperationResult },
      },
    },
    async (request) => service.updateMaturity(request.params.id, request.body, actor(request)),
  );

  app.post(
    "/securities/:id/redeem",
    {
      preHandler: app.requireRole("issuer"),
      schema: {
        tags: ["securities"],
        summary: "Redeem a matured holding",
        description:
          "The manual override on the maturity sweep. Omit the amount to redeem the " +
          "holder's whole balance. Refused before maturity, as on chain.",
        security: [{ bearerAuth: [] }],
        params: SecurityParams,
        body: RedeemRequest,
        response: { 200: ChainOperationResult },
      },
    },
    async (request) => service.redeem(request.params.id, request.body, actor(request)),
  );

  app.post(
    "/securities/sweep-maturity",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["securities"],
        summary: "Redeem every matured holding",
        description:
          "The scheduled half of redemption, so nobody has to remember a maturity " +
          "date. Walks confirmed wallets only. One holder that fails does not stop " +
          "the rest, and every failure is reported rather than swallowed.",
        security: [{ bearerAuth: [] }],
        response: { 200: SweepResult },
      },
    },
    async (request) => service.sweepMatured(actor(request)),
  );
};
