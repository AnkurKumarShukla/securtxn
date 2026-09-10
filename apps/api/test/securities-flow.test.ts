// Issuance and lifecycle, driven through HTTP.
//
// Runs against the mock chain gateway, which keeps balances in memory. That is
// the point: a mint really moves a balance here, so these tests check behaviour
// rather than that a route returned 201. What the mock deliberately does NOT
// simulate is the compliance gate — that is proven on the real chain (D46), and
// a fake version would only teach this suite to trust a rule it invented.
//
// Spec: docs/architecture.md §4.5

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { fromBaseUnits, toBaseUnits } from "../src/modules/securities/service.js";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

let app: FastifyInstance;
let issuerToken: string;
let agentToken: string;
let vendorId: string;
let walletId: string;
let pendingWalletId: string;
const securityIds: string[] = [];

const asIssuer = () => ({ authorization: `Bearer ${issuerToken}` });

function inOneYear(): string {
  return new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
}

async function issue(overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/securities",
    headers: asIssuer(),
    payload: {
      name: "Meridian Receivable 2027",
      symbol: `RCV${Math.floor(Math.random() * 100000)}`,
      nominalValue: "100.00",
      maxSupply: "1000.00",
      maturityDate: inOneYear(),
      ...overrides,
    },
  });
  if (response.statusCode === 201) securityIds.push(response.json().id);
  return response;
}

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    COMPLIANCE_GATEWAY: "mock",
    CHAIN_GATEWAY: "mock",
  };
  app = await buildServer(config);
  await app.ready();
  issuerToken = await app.signToken("issuer", "securities-test");
  agentToken = await app.signToken("agent", "securities-test");

  const vendor = await prisma.vendor.create({
    data: {
      payeeType: "BUSINESS",
      legalEntityName: "Meridian Components Private Limited",
      country: "IN",
      verificationTier: "TIER2_IDENTITY",
    },
  });
  vendorId = vendor.id;

  walletId = (
    await prisma.vendorWallet.create({
      data: {
        vendorId,
        address: PAYEE,
        network: "hedera",
        version: 1,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    })
  ).id;

  pendingWalletId = (
    await prisma.vendorWallet.create({
      data: { vendorId, address: OTHER, network: "hedera", version: 2 },
    })
  ).id;
});

afterAll(async () => {
  await prisma.securityEvent.deleteMany({ where: { securityId: { in: securityIds } } });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app?.close();
  await prisma.$disconnect();
});

describe("amount scaling", () => {
  // Done on strings, never through a float, because this value is money about
  // to be written to a ledger that takes no corrections.
  it("scales without floating point", () => {
    expect(toBaseUnits("0.1", 2)).toBe(10n);
    expect(toBaseUnits("12345.67", 2)).toBe(1234567n);
    expect(toBaseUnits("1", 18)).toBe(1_000_000_000_000_000_000n);
  });

  it("round-trips", () => {
    expect(fromBaseUnits(toBaseUnits("12345.67", 2), 2)).toBe("12345.67");
    expect(fromBaseUnits(1234500n, 2)).toBe("12345");
    expect(fromBaseUnits(0n, 2)).toBe("0");
  });

  it("refuses more precision than the token can hold", () => {
    // Silently truncating would pay a different amount than the one approved.
    expect(() => toBaseUnits("1.234", 2)).toThrow(/decimal places/);
  });
});

describe("issuing a security", () => {
  it("deploys, prepares and records both in the history", async () => {
    const response = await issue();
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.evmAddress).toMatch(/^0x[0-9a-f]{40}$/);
    // Without a registered credential issuer every later grantKyc reverts, so
    // preparation runs in the same call rather than as a follow-up nobody makes.
    expect(body.issuerRegistered).toBe(true);
    expect(body.status).toBe("ISSUED");
    // Mocked, so there is nothing to link to. A dead explorer link reads as a bug.
    expect(body.explorerUrl).toBeNull();

    const events = await app.inject({
      method: "GET",
      url: `/securities/${body.id}/events`,
      headers: asIssuer(),
    });
    expect(events.json().map((e: { kind: string }) => e.kind)).toEqual(["ISSUED", "PREPARED"]);
  });

  it("generates a valid ISIN when none is given", async () => {
    const body = (await issue()).json();
    // The factory rejects a bad check digit with WrongISINChecksum, so asking a
    // UI to implement ISO 6166 is asking for that revert.
    expect(body.isin).toMatch(/^IN[A-Z0-9]{9}[0-9]$/);
  });

  it("refuses a maturity date in the past", async () => {
    const response = await issue({ maturityDate: new Date(Date.now() - 1000).toISOString() });
    expect(response.statusCode).toBe(422);
  });

  it("refuses an ISIN with a bad check digit", async () => {
    const response = await issue({ isin: "INE0000000A9" });
    expect(response.statusCode).toBe(422);
  });

  it("rejects an agent token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/securities",
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        name: "X",
        symbol: "X",
        nominalValue: "1.00",
        maxSupply: "1.00",
        maturityDate: inOneYear(),
      },
    });
    // 401, not 403: each role verifies against its own secret, so an agent
    // token fails the signature check before any role comparison happens. That
    // is what makes the separation structural rather than a string test (D12).
    expect(response.statusCode).toBe(401);
  });
});

describe("minting", () => {
  it("moves a balance and records the event", async () => {
    const security = (await issue()).json();

    const minted = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId, amount: "500.00" },
    });

    expect(minted.statusCode).toBe(201);
    expect(minted.json().kind).toBe("MINTED");
    // Never presented as an on-chain fact when nothing was broadcast (D21).
    expect(minted.json().broadcast).toBe(false);

    const holdings = await app.inject({
      method: "GET",
      url: `/securities/${security.id}/holdings`,
      headers: asIssuer(),
    });
    expect(holdings.json()).toEqual([
      { address: PAYEE, balance: "500", balanceBaseUnits: "50000" },
    ]);
  });

  it("refuses a wallet that is not CONFIRMED", async () => {
    const security = (await issue()).json();
    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: asIssuer(),
      payload: { vendorWalletId: pendingWalletId, amount: "1.00" },
    });
    // The token would accept an address with KYC even after this platform
    // revoked its wallet. That divergence is what wallet status exists to close.
    expect(response.statusCode).toBe(409);
  });

  it("refuses to exceed the cap", async () => {
    const security = (await issue({ maxSupply: "10.00" })).json();
    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId, amount: "10.01" },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("corporate actions", () => {
  it("schedules a coupon", async () => {
    const security = (await issue()).json();
    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/coupon`,
      headers: asIssuer(),
      payload: {
        recordDate: new Date(Date.now() + 3600_000).toISOString(),
        executionDate: new Date(Date.now() + 7200_000).toISOString(),
        rate: "2.50",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().kind).toBe("COUPON_SET");
  });

  it("refuses an execution date past maturity", async () => {
    const security = (await issue()).json();
    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/coupon`,
      headers: asIssuer(),
      payload: {
        recordDate: new Date(Date.now() + 3600_000).toISOString(),
        executionDate: new Date(Date.now() + 400 * 24 * 3600_000).toISOString(),
        rate: "2.50",
      },
    });
    // The contract refuses this too, but less legibly.
    expect(response.statusCode).toBe(422);
  });

  it("refuses an execution date before the record date", async () => {
    const security = (await issue()).json();
    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/coupon`,
      headers: asIssuer(),
      payload: {
        recordDate: new Date(Date.now() + 7200_000).toISOString(),
        executionDate: new Date(Date.now() + 3600_000).toISOString(),
        rate: "2.50",
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it("moves the maturity date forward", async () => {
    const security = (await issue()).json();
    const maturityDate = new Date(Date.now() + 60_000).toISOString();

    const response = await app.inject({
      method: "PATCH",
      url: `/securities/${security.id}/maturity`,
      headers: asIssuer(),
      payload: { maturityDate },
    });

    expect(response.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: `/securities/${security.id}`,
      headers: asIssuer(),
    });
    expect(after.json().maturityDate).toBe(maturityDate);
  });

  it("refuses a maturity date already in the past", async () => {
    const security = (await issue()).json();
    const response = await app.inject({
      method: "PATCH",
      url: `/securities/${security.id}/maturity`,
      headers: asIssuer(),
      payload: { maturityDate: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("redemption", () => {
  it("refuses before maturity", async () => {
    const security = (await issue()).json();
    await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId, amount: "100.00" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/redeem`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId },
    });
    // Ending an instrument early is a decision, not a retry.
    expect(response.statusCode).toBe(422);
  });

  it("redeems the whole holding once matured", async () => {
    const security = (await issue()).json();
    await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId, amount: "250.00" },
    });
    await prisma.security.update({
      where: { id: security.id },
      data: { maturityDate: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/redeem`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().detail.amount).toBe("250");

    const after = await app.inject({
      method: "GET",
      url: `/securities/${security.id}`,
      headers: asIssuer(),
    });
    expect(after.json().status).toBe("MATURED");
  });

  it("sweeps every matured security without being asked per holder", async () => {
    const security = (await issue()).json();
    await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: asIssuer(),
      payload: { vendorWalletId: walletId, amount: "75.00" },
    });
    await prisma.security.update({
      where: { id: security.id },
      data: { maturityDate: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/securities/sweep-maturity",
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(response.statusCode).toBe(200);
    const swept = response
      .json()
      .redeemed.filter((r: { securityId: string }) => r.securityId === security.id);
    // Nobody should have to remember a maturity date.
    expect(swept).toHaveLength(1);
    expect(swept[0].amount).toBe("75");
    expect(response.json().failed).toEqual([]);
  });
});
