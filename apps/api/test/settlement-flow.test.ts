// HTLC settlement, end to end through the API.
//
// The rows here are created directly rather than through onboarding: this suite
// is about what happens AFTER a payment is approved and sent, and routing every
// case through DigiLocker onboarding would make it depend on gitignored
// fixtures that are not present on every machine.
//
// Spec: docs/architecture.md §4.5

import { computeLockId, hashlockFor, newPreimage, paymentRefFor } from "@cp/contracts";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { recommendSettlementMode } from "../src/modules/decision/index.js";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const PAYER = "0xe894a3f95ea13444B669E9243bA4e7c934CDeC0d" as Address;
const ESCROW = "0x8ad684cff71aa37c7aa5a53b3a443dcd3e82285e" as Address;
const TOKEN = "0x8418e76609e60e16dfa22722e707381da9b9173a" as Address;

let app: FastifyInstance;
let token: string;
let vendorId: string;
let walletId: string;
const paymentIds: string[] = [];

const auth = () => ({ authorization: `Bearer ${token}` });
const txHash = (seed: string) => keccak256(Buffer.from(seed));

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    COMPLIANCE_GATEWAY: "mock",
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "settlement-flow-test");

  const vendor = await prisma.vendor.create({
    data: {
      payeeType: "BUSINESS",
      legalEntityName: "Northwind Logistics Private Limited",
      country: "IN",
      verificationTier: "TIER2_IDENTITY",
    },
  });
  vendorId = vendor.id;

  const wallet = await prisma.vendorWallet.create({
    data: {
      vendorId,
      address: PAYEE,
      network: "hedera",
      version: 1,
      status: "CONFIRMED",
      confirmedAt: new Date(),
    },
  });
  walletId = wallet.id;
});

afterAll(async () => {
  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.htlcSettlement.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.recipientAcknowledgment.deleteMany({
    where: { paymentRequestId: { in: paymentIds } },
  });
  await prisma.exceptionCase.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app?.close();
  await prisma.$disconnect();
});

/** A payment already sent, in the given mode — the state a lock arrives in. */
async function sentPayment(mode: "DIRECT" | "HTLC"): Promise<string> {
  const payment = await prisma.paymentRequest.create({
    data: {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef: `INV-${Math.random().toString(36).slice(2, 10)}`,
      amount: new Prisma.Decimal("500.00"),
      token: "USDC",
      network: "hedera",
      settlementMode: mode,
      senderContextCommitment: `0x${"ab".repeat(32)}`,
      status: "SENT",
      decision: "SAFE_TO_SEND",
      decisionReasonCode: "ALL_CHECKS_PASSED",
    },
  });
  paymentIds.push(payment.id);
  return payment.id;
}

/**
 * A lock report whose id is derived exactly as the contract derives it.
 *
 * Built from the same helper the API checks against, so a test that passes here
 * would also pass against the deployed escrow — the alternative, a hard-coded
 * id, would only prove the two sides agree on a constant.
 */
function lockPayload(
  paymentId: string,
  overrides: { hashlock?: Hex; timelock?: Date; amount?: string; onChainAmount?: bigint } = {},
) {
  const hashlock = overrides.hashlock ?? hashlockFor(newPreimage());
  const timelock = overrides.timelock ?? new Date(Date.now() + 3_600_000);
  const onChainAmount = overrides.onChainAmount ?? 50_000n;

  return {
    escrowAddress: ESCROW,
    lockId: computeLockId({
      paymentRef: paymentRefFor(paymentId),
      payer: PAYER,
      payee: PAYEE,
      token: TOKEN,
      amount: onChainAmount,
      hashlock,
      timelock: BigInt(Math.floor(timelock.getTime() / 1000)),
    }),
    hashlock,
    timelock: timelock.toISOString(),
    payerAddress: PAYER,
    tokenAddress: TOKEN,
    amount: overrides.amount ?? "500.00",
    onChainAmount: onChainAmount.toString(),
    lockTxHash: txHash(`lock-${paymentId}`),
  };
}

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: auth(), payload: payload as object });

describe("settlement mode is chosen per payment", () => {
  it("defaults to DIRECT when the caller says nothing", async () => {
    const created = await post("/payments", {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef: "INV-DEFAULT-MODE",
      amount: "100.00",
      token: "USDC",
      network: "hedera",
    });
    expect(created.statusCode).toBe(201);
    paymentIds.push(created.json().id);
    // The mode that always pays has to be the one you get by not choosing (D41).
    expect(created.json().settlementMode).toBe("DIRECT");
  });

  it("records HTLC when the caller opts in", async () => {
    const created = await post("/payments", {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef: "INV-OPT-IN",
      amount: "100.00",
      token: "USDC",
      network: "hedera",
      settlementMode: "HTLC",
    });
    paymentIds.push(created.json().id);
    expect(created.json().settlementMode).toBe("HTLC");
  });

  it("recommends an escrow only for a first payment to an address", () => {
    expect(recommendSettlementMode("NEW_OR_CHANGED_ADDRESS")).toBe("HTLC");
    expect(recommendSettlementMode("ALL_CHECKS_PASSED")).toBe("DIRECT");
    // A blocked payment settles no way at all; the recommendation must not read
    // as an invitation to route it through an escrow instead.
    expect(recommendSettlementMode("SANCTIONS_HIT")).toBe("DIRECT");
  });
});

describe("recording a lock", () => {
  it("stores the escrow and writes one evidence record", async () => {
    const paymentId = await sentPayment("HTLC");
    const response = await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("LOCKED");
    // The payee is taken from the confirmed wallet, never from the request.
    expect(response.json().payeeAddress).toBe(PAYEE);

    const evidence = await prisma.evidenceRecord.findMany({ where: { paymentRequestId: paymentId } });
    expect(evidence.map((e) => e.eventType)).toEqual(["htlc_locked"]);
  });

  it("refuses a lock id that does not match the reported parameters", async () => {
    const paymentId = await sentPayment("HTLC");
    const payload = { ...lockPayload(paymentId), lockId: `0x${"99".repeat(32)}` };

    const response = await post(`/payments/${paymentId}/settlement/lock`, payload);

    // An escrow stored under an id the chain never issued is money nobody can
    // find again, so this has to fail loudly rather than be recorded as-is.
    expect(response.statusCode).toBe(422);
    expect(await prisma.htlcSettlement.count({ where: { paymentRequestId: paymentId } })).toBe(0);
  });

  it("refuses a lock against a payment that settles directly", async () => {
    const paymentId = await sentPayment("DIRECT");
    const response = await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));
    expect(response.statusCode).toBe(422);
  });

  it("refuses a lock before the payment has been sent", async () => {
    const paymentId = await sentPayment("HTLC");
    await prisma.paymentRequest.update({
      where: { id: paymentId },
      data: { status: "AWAITING_APPROVAL" },
    });
    const response = await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));
    expect(response.statusCode).toBe(422);
  });

  it("refuses a second escrow for the same payment", async () => {
    const paymentId = await sentPayment("HTLC");
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));
    const again = await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));
    expect(again.statusCode).toBe(409);
  });
});

describe("claiming — the preimage is the receipt", () => {
  it("accepts the matching preimage and records the acknowledgment", async () => {
    const paymentId = await sentPayment("HTLC");
    const preimage = newPreimage();
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId, {
      hashlock: hashlockFor(preimage),
    }));

    const claimTxHash = txHash(`claim-${paymentId}`);
    const response = await post(`/payments/${paymentId}/settlement/claim`, {
      preimage,
      claimTxHash,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("CLAIMED");
    expect(response.json().preimage).toBe(preimage);

    // The point of D41: collecting the money produced the acknowledgment. No
    // separate signature was ever asked for.
    const ack = await prisma.recipientAcknowledgment.findUnique({
      where: { paymentRequestId: paymentId },
    });
    expect(ack?.method).toBe("HTLC_CLAIM");
    expect(ack?.recipientAddress).toBe(PAYEE);
    expect(ack?.recipientSignature).toBeNull();
    expect(ack?.claimTxHash).toBe(claimTxHash);

    const evidence = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: paymentId },
      orderBy: { createdAt: "asc" },
    });
    expect(evidence.map((e) => e.eventType)).toEqual(["htlc_locked", "htlc_claimed", "ack"]);
  });

  it("refuses a preimage that does not hash to the stored hashlock", async () => {
    const paymentId = await sentPayment("HTLC");
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));

    const response = await post(`/payments/${paymentId}/settlement/claim`, {
      preimage: newPreimage(),
      claimTxHash: txHash(`bad-claim-${paymentId}`),
    });

    // Without this check the "receipt" would be an unverified assertion that a
    // claim happened, which is exactly what the hashlock exists to replace.
    expect(response.statusCode).toBe(422);
    const row = await prisma.htlcSettlement.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    expect(row.status).toBe("LOCKED");
    expect(row.preimage).toBeNull();
  });

  it("refuses to claim an escrow twice", async () => {
    const paymentId = await sentPayment("HTLC");
    const preimage = newPreimage();
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId, {
      hashlock: hashlockFor(preimage),
    }));
    await post(`/payments/${paymentId}/settlement/claim`, {
      preimage,
      claimTxHash: txHash(`c1-${paymentId}`),
    });
    const again = await post(`/payments/${paymentId}/settlement/claim`, {
      preimage,
      claimTxHash: txHash(`c2-${paymentId}`),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("refunding — the money comes back", () => {
  /** Expired on arrival, which is the only state a refund is legal in. */
  const expired = () => ({ timelock: new Date(Date.now() - 60_000) });

  it("returns the escrow and opens an exception case", async () => {
    const paymentId = await sentPayment("HTLC");
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId, expired()));

    const response = await post(`/payments/${paymentId}/settlement/refund`, {
      refundTxHash: txHash(`refund-${paymentId}`),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("REFUNDED");

    // Recovering the money is the good outcome, but a verified payee who never
    // collected an approved payment is still something a human must look at.
    const exception = await prisma.exceptionCase.findUnique({
      where: { paymentRequestId: paymentId },
    });
    expect(exception?.type).toBe("MISDIRECT");
    expect(exception?.status).toBe("OPEN");

    const payment = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("EXCEPTION");

    const evidence = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: paymentId },
      orderBy: { createdAt: "asc" },
    });
    expect(evidence.map((e) => e.eventType)).toEqual([
      "htlc_locked",
      "htlc_refunded",
      "exception_opened",
    ]);
  });

  it("refuses a refund before the timelock, as the contract does", async () => {
    const paymentId = await sentPayment("HTLC");
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId));

    const response = await post(`/payments/${paymentId}/settlement/refund`, {
      refundTxHash: txHash(`early-${paymentId}`),
    });

    expect(response.statusCode).toBe(422);
    const row = await prisma.htlcSettlement.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    expect(row.status).toBe("LOCKED");
  });

  it("refuses to refund an escrow that was already claimed", async () => {
    const paymentId = await sentPayment("HTLC");
    const preimage = newPreimage();
    await post(`/payments/${paymentId}/settlement/lock`, lockPayload(paymentId, {
      ...expired(),
      hashlock: hashlockFor(preimage),
    }));
    // Claimed before expiry on chain; the API only sees the reported order.
    await post(`/payments/${paymentId}/settlement/claim`, {
      preimage,
      claimTxHash: txHash(`raced-${paymentId}`),
    });

    const response = await post(`/payments/${paymentId}/settlement/refund`, {
      refundTxHash: txHash(`double-${paymentId}`),
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("reading a settlement back", () => {
  it("404s when the payment has no escrow", async () => {
    const paymentId = await sentPayment("HTLC");
    const response = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}/settlement`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires an agent token", async () => {
    const paymentId = await sentPayment("HTLC");
    const response = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}/settlement`,
    });
    expect(response.statusCode).toBe(401);
  });
});
