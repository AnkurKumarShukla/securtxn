// World ID routes over the real HTTP surface (B4, D49).
//
// world-id.test.ts covers the service. This covers what a caller actually
// experiences: that the routes exist, that the feature flag fails CLOSED, and
// that every refusal reaches the client as a distinguishable status rather than
// a generic 400 — an operator in a dispute needs to tell "different human" from
// "already used".
//
// Driven off the real sandbox captures in fixtures/worldid/, with the upstream
// verifier stubbed at the container so no test touches the live World endpoint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { WorldIdService } from "../src/modules/worldid/service.js";
import type { IdKitProof } from "../src/modules/worldid/WorldIdProofVerifier.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "worldid");
const capture = JSON.parse(readFileSync(join(FIXTURES, "01_selfie_check_first.json"), "utf8"));
const ACTION = "verify-payment-approver";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

let enabled: FastifyInstance;
let disabled: FastifyInstance;
let token: string;
const subjects: string[] = [];

let seq = 0;
const newSubject = () => {
  const s = `wid-route-${Date.now()}-${seq++}`;
  subjects.push(s);
  return s;
};

/** A copy of the capture's proof rebound to a signal. */
function proofFor(signal: string): IdKitProof {
  const proof = structuredClone(capture.idkit) as IdKitProof & {
    responses: { signal_hash: string }[];
  };
  proof.responses[0]!.signal_hash = hashSignal(signal);
  return proof;
}

/** Replays the recorded upstream response; never reaches the network. */
function stubVerifier(nullifierHex = capture.upstream.nullifier) {
  return {
    async verify(proof: IdKitProof) {
      return {
        nullifierHex,
        signalHash: proof.responses?.[0]?.signal_hash ?? "",
        credential: capture.upstream.results[0].identifier as string,
        action: capture.upstream.action as string,
        environment: capture.upstream.environment as string,
        upstreamReuse: false,
      };
    },
  };
}

beforeAll(async () => {
  const shared = { ...base, NODE_ENV: "test" as const, isProduction: false, RATE_LIMIT_MAX: 1_000_000 };

  enabled = await buildServer({
    ...shared,
    WORLD_FEATURE_FLAG_ENABLED: true,
    WORLD_RP_ID: "rp_test",
    WORLD_ACTION: ACTION,
  } as Config);
  await enabled.ready();
  // AFTER ready(): containerPlugin runs during ready() and would overwrite a
  // stub assigned before it — which silently sent the first run at the LIVE
  // World verifier.
  enabled.container.worldId = new WorldIdService({
    prisma,
    expectedAction: ACTION,
    verifier: stubVerifier(),
  });
  token = await enabled.signToken("agent", "world-id-routes-test");

  disabled = await buildServer({ ...shared, WORLD_FEATURE_FLAG_ENABLED: false } as Config);
  await disabled.ready();
});

afterAll(async () => {
  await prisma.worldIdVerification.deleteMany({ where: { subject: { in: subjects } } });
  await enabled?.close();
  await disabled?.close();
  await prisma.$disconnect();
});

const post = (app: FastifyInstance, path: string, payload: unknown) =>
  app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

describe("World ID routes", () => {
  it("enrols a subject from a real Selfie Check capture", async () => {
    const subject = newSubject();
    const signal = `${subject}:enroll`;

    const res = await post(enabled, "/world-id/enroll", {
      proof: proofFor(signal),
      signal,
      subject,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ credential: "selfie", purpose: "ENROLLMENT" });
  });

  it("accepts a later proof from the SAME human", async () => {
    const subject = newSubject();
    await post(enabled, "/world-id/enroll", {
      proof: proofFor(`${subject}:enroll`),
      signal: `${subject}:enroll`,
      subject,
    });

    const res = await post(enabled, "/world-id/verify", {
      proof: proofFor(`${subject}:pay-1`),
      signal: `${subject}:pay-1`,
      subject,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().purpose).toBe("REVERIFICATION");
  });

  it("refuses a proof bound to a different signal — 400", async () => {
    // The v4 verifier is never told which signal we expected, so this check is
    // ours. Without it, a valid proof bound to anything would authorise this
    // action (D49b).
    const subject = newSubject();
    const res = await post(enabled, "/world-id/enroll", {
      proof: proofFor("some-other-context"),
      signal: `${subject}:enroll`,
      subject,
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses a replayed proof — 409, not a generic 400", async () => {
    const subject = newSubject();
    const body = {
      proof: proofFor(`${subject}:enroll`),
      signal: `${subject}:enroll`,
      subject,
    };

    expect((await post(enabled, "/world-id/enroll", body)).statusCode).toBe(200);
    expect((await post(enabled, "/world-id/enroll", body)).statusCode).toBe(409);
  });

  it("refuses a valid proof from a DIFFERENT human — 403", async () => {
    const subject = newSubject();
    await post(enabled, "/world-id/enroll", {
      proof: proofFor(`${subject}:enroll`),
      signal: `${subject}:enroll`,
      subject,
    });

    // Same subject, same signal shape, but a different person's nullifier.
    const stranger = await buildServer({
      ...base,
      NODE_ENV: "test" as const,
      isProduction: false,
      RATE_LIMIT_MAX: 1_000_000,
      WORLD_FEATURE_FLAG_ENABLED: true,
      WORLD_RP_ID: "rp_test",
      WORLD_ACTION: ACTION,
    } as Config);
    await stranger.ready();
    stranger.container.worldId = new WorldIdService({
      prisma,
      expectedAction: ACTION,
      verifier: stubVerifier(`0x${"deadbeef".repeat(8)}`),
    });

    const res = await stranger.inject({
      method: "POST",
      url: "/world-id/verify",
      headers: { authorization: `Bearer ${await stranger.signToken("agent", "stranger")}` },
      payload: {
        proof: proofFor(`${subject}:pay-2`),
        signal: `${subject}:pay-2`,
        subject,
      } as never,
    });

    expect(res.statusCode).toBe(403);
    await stranger.close();
  });

  it("fails closed when the subject never enrolled — 409", async () => {
    // "Nothing to compare against" must never read as "the check passed".
    const subject = newSubject();
    const res = await post(enabled, "/world-id/verify", {
      proof: proofFor(`${subject}:pay-3`),
      signal: `${subject}:pay-3`,
      subject,
    });

    expect(res.statusCode).toBe(409);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await enabled.inject({
      method: "POST",
      url: "/world-id/enroll",
      headers: { authorization: "Bearer nope" },
      payload: { proof: proofFor("x"), signal: "x", subject: "x" } as never,
    });

    expect(res.statusCode).toBe(401);
  });

  it("fails CLOSED with 503 when the feature flag is off", async () => {
    // A disabled control must be loudly absent, never silently permissive.
    const subject = newSubject();
    const res = await disabled.inject({
      method: "POST",
      url: "/world-id/enroll",
      headers: { authorization: `Bearer ${await disabled.signToken("agent", "off")}` },
      payload: {
        proof: proofFor(`${subject}:enroll`),
        signal: `${subject}:enroll`,
        subject,
      } as never,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("WORLD_ID_DISABLED");
  });

  it("rejects a malformed proof envelope before it reaches the verifier", async () => {
    const res = await post(enabled, "/world-id/enroll", {
      proof: { responses: [] },
      signal: "s",
      subject: "s",
    });

    expect(res.statusCode).toBe(400);
  });
});
