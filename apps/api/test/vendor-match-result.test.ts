// The verdict callback endpoint (D48) — the return path that makes a CRE
// vendor match usable at all, since the HTTP trigger is fire-and-forget.
//
// The risk here is not "does it write a row". It is that this endpoint accepts
// a verdict from outside and a payment is gated on what it stores, so the
// tests below are mostly about what it must REFUSE: an unsolicited requestId,
// an unauthenticated caller, and a second verdict overwriting the first.

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

let app: FastifyInstance;
let token: string;
let vendorId: string;
const requestIds: string[] = [];

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "vendor-match-result-test");

  const vendor = await prisma.vendor.create({
    data: { payeeType: "BUSINESS", legalEntityName: "Callback Fixture Co", country: "IN" },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await prisma.vendorMatchRequest.deleteMany({ where: { id: { in: requestIds } } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app?.close();
  await prisma.$disconnect();
});

/** A PENDING row, as the matcher creates before invoking the workflow. */
async function pendingRequest() {
  const row = await prisma.vendorMatchRequest.create({
    data: { vendorId, walletAddress: WALLET, network: "ethereum" },
    select: { id: true },
  });
  requestIds.push(row.id);
  return row.id;
}

const post = (payload: unknown, auth = `Bearer ${token}`) =>
  app.inject({
    method: "POST",
    url: "/internal/vendor-match-result",
    headers: { authorization: auth },
    payload: payload as never,
  });

describe("vendor-match verdict callback (D48)", () => {
  it("records the verdict against the pending request", async () => {
    const requestId = await pendingRequest();

    const response = await post({
      requestId,
      match: true,
      score: 0.93,
      reasonCode: "MATCHED",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "RECORDED" });

    const row = await prisma.vendorMatchRequest.findUnique({ where: { id: requestId } });
    expect(row).toMatchObject({
      status: "COMPLETED",
      match: true,
      score: 0.93,
      reasonCode: "MATCHED",
    });
    expect(row?.completedAt).not.toBeNull();
  });

  it("rejects a verdict for a requestId nobody asked for", async () => {
    // This is the control that stops the endpoint from being a way to inject a
    // verdict for a match that was never requested. The row is created before
    // the workflow is invoked precisely so this check can exist.
    const response = await post({
      requestId: "00000000-0000-4000-8000-0000000000ff",
      match: true,
      score: 1,
      reasonCode: "MATCHED",
    });

    expect(response.statusCode).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    const requestId = await pendingRequest();
    const response = await post(
      { requestId, match: true, score: 1, reasonCode: "MATCHED" },
      "Bearer not-a-token",
    );

    expect(response.statusCode).toBe(401);

    const row = await prisma.vendorMatchRequest.findUnique({ where: { id: requestId } });
    expect(row?.status).toBe("PENDING");
  });

  it("is idempotent — a DON sends one callback per observing node", async () => {
    // Not a nicety. In DON mode every node runs the handler and posts the same
    // verdict, so N callbacks arrive for one logical answer; the ngrok
    // inspector shows five lookups per execution. The first wins and the rest
    // are acknowledged without changing anything.
    const requestId = await pendingRequest();

    const first = await post({ requestId, match: false, score: 0.1, reasonCode: "NAME_BELOW_THRESHOLD" });
    const second = await post({ requestId, match: false, score: 0.1, reasonCode: "NAME_BELOW_THRESHOLD" });
    const third = await post({ requestId, match: false, score: 0.1, reasonCode: "NAME_BELOW_THRESHOLD" });

    expect(first.json()).toEqual({ status: "RECORDED" });
    expect(second.json()).toEqual({ status: "ALREADY_RECORDED" });
    expect(third.json()).toEqual({ status: "ALREADY_RECORDED" });
  });

  it("does not let a late, conflicting verdict overwrite the recorded one", async () => {
    const requestId = await pendingRequest();

    await post({ requestId, match: false, score: 0, reasonCode: "WALLET_NOT_ON_FILE" });
    await post({ requestId, match: true, score: 1, reasonCode: "MATCHED" });

    const row = await prisma.vendorMatchRequest.findUnique({ where: { id: requestId } });
    expect(row).toMatchObject({ match: false, reasonCode: "WALLET_NOT_ON_FILE" });
  });

  it("records a failure as FAILED, never as a negative verdict", async () => {
    // "We could not check" must not reach the decision engine looking like
    // "we checked and it failed" (D44) — so it lands in a different status
    // with a null match, not match:false.
    const requestId = await pendingRequest();

    const response = await post({
      requestId,
      failureReason: "vendor lookup failed with status 503",
    });

    expect(response.statusCode).toBe(200);

    const row = await prisma.vendorMatchRequest.findUnique({ where: { id: requestId } });
    expect(row).toMatchObject({ status: "FAILED", match: null, reasonCode: null });
    expect(row?.failureReason).toMatch(/503/);
  });

  it("rejects a body that is neither a verdict nor a failure", async () => {
    const requestId = await pendingRequest();
    const response = await post({ requestId });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a score outside 0..1", async () => {
    const requestId = await pendingRequest();
    const response = await post({ requestId, match: true, score: 42, reasonCode: "MATCHED" });

    expect(response.statusCode).toBe(400);
  });
});
