import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

const CONFIRMED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // the seeded wallet
const UNKNOWN = "0x000000000000000000000000000000000000dEaD";

let app: FastifyInstance;
let token: string;
let vendorId: string;
const walletIds: string[] = [];

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    // Pinned, not inherited. The deployed default is `cre`, and letting the
    // suite pick that up would drive every test through a live DON and a
    // public tunnel — slow, flaky, and dependent on a Vault secret that
    // expires. The fallback exists precisely so the tests do not need an
    // enclave (D09), and one shared contract suite proves the two agree.
    VENDOR_MATCHER: "fallback",
    // Pinned for the same reason as VENDOR_MATCHER: the deployed default now
    // talks to Hedera testnet, and a unit suite must not depend on a public
    // network being up. The on-chain branch is covered by decision.test.ts.
    COMPLIANCE_GATEWAY: "mock",
    // Pinned with the other two: the deployed default now broadcasts to Hedera
    // testnet, and no unit test may spend real testnet funds or depend on a
    // public network being up.
    CHAIN_GATEWAY: "mock",
    RATE_LIMIT_MAX: 1_000_000,
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "registry-test");

  const vendor = await prisma.vendor.create({
    data: { payeeType: "BUSINESS", legalEntityName: "Registry Fixture Co", country: "IN" },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  // Confirming a wallet issues a credential when ATS_ISSUER_PRIVATE_KEY is set
  // (D40); VerifiableCredential.walletId is onDelete: Restrict.
  await prisma.verifiableCredential.deleteMany({ where: { walletId: { in: walletIds } } });
  await prisma.vendorWallet.deleteMany({ where: { id: { in: walletIds } } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app?.close();
  await prisma.$disconnect();
});

async function wallet(address: string, status: "PENDING_VERIFICATION" | "CONFIRMED" | "REVOKED", version: number) {
  const row = await prisma.vendorWallet.create({
    data: { vendorId, address, network: "ethereum", version, status },
  });
  walletIds.push(row.id);
  return row;
}

const ask = (address: string, query = "") =>
  app.inject({
    method: "GET",
    url: `/internal/identity-registry/${address}${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe("identity registry hook", () => {
  it("confirms a CONFIRMED wallet", async () => {
    const res = await ask(CONFIRMED);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verified: true });
    expect(res.json().vendorId).toBeTruthy();
  });

  it("matches case-insensitively", async () => {
    // A checksummed address from the chain and a lowercased one in the
    // database are the same address. An exact match would answer "not
    // verified" for a confirmed wallet and block a legitimate transfer.
    const lower = await ask(CONFIRMED.toLowerCase());
    const upper = await ask(`0x${CONFIRMED.slice(2).toUpperCase()}`);
    expect(lower.json().verified).toBe(true);
    expect(upper.json().verified).toBe(true);
  });

  it("answers no for an address it has never seen", async () => {
    const res = await ask(UNKNOWN);
    expect(res.json()).toMatchObject({ verified: false, vendorId: null });
  });

  it("answers no for a wallet still pending", async () => {
    const pending = "0x1111111111111111111111111111111111111111";
    await wallet(pending, "PENDING_VERIFICATION", 101);
    expect((await ask(pending)).json().verified).toBe(false);
  });

  it("answers no for a revoked wallet", async () => {
    // Fails closed: this endpoint gates transfers, so anything short of a
    // positive confirmation must be a no.
    const revoked = "0x2222222222222222222222222222222222222222";
    await wallet(revoked, "REVOKED", 102);
    expect((await ask(revoked)).json().verified).toBe(false);
  });

  it("honours a re-confirmation after revocation", async () => {
    // An address can legitimately reappear as a later version. The most recent
    // confirmation is the current truth.
    const rotated = "0x3333333333333333333333333333333333333333";
    await wallet(rotated, "REVOKED", 103);
    await wallet(rotated, "CONFIRMED", 104);
    expect((await ask(rotated)).json().verified).toBe(true);
  });

  it("filters by network when asked", async () => {
    // The same address can be registered on more than one chain.
    const multi = "0x4444444444444444444444444444444444444444";
    await wallet(multi, "CONFIRMED", 105);
    expect((await ask(multi, "?network=ethereum")).json().verified).toBe(true);
    expect((await ask(multi, "?network=hedera")).json().verified).toBe(false);
  });

  it("rejects a malformed address rather than answering", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/identity-registry/not-an-address",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    // An open endpoint answering "is this a confirmed vendor address?" would
    // let anyone enumerate the platform's business relationships.
    const res = await app.inject({
      method: "GET",
      url: `/internal/identity-registry/${CONFIRMED}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
