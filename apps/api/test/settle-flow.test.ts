// Releasing an approved payment through the API, both settlement modes.
//
// This is the route that spends, so most of what is checked here is what it
// REFUSES: a payment nobody approved, an agent token, a secret handed to
// someone who cannot sign for the payout address, a refund before the deadline.
//
// Runs on the mock chain gateway, which keeps real balances. A lock therefore
// debits the treasury and a refund credits it back, so the recovery path is
// tested as behaviour rather than as a status string.
//
// Spec: docs/architecture.md §4.1, §4.5

import { hashlockFor, newPreimage } from "@cp/contracts";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import {
  SECRET_RELEASE_TYPES,
  buildSecretReleaseMessage,
  domainFor,
} from "../src/lib/eip712.js";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

/** Anvil account #1. Public key, testnet only — it is the payout address here. */
const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
/** Anvil account #2, used to prove a stranger's signature does not release a secret. */
const STRANGER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

const TOKEN = "0x8418e76609e60e16dfa22722e707381da9b9173a";

let app: FastifyInstance;
let agentToken: string;
let approverToken: string;
let issuerToken: string;
let vendorId: string;
let walletId: string;
let chainId: number;
const paymentIds: string[] = [];
const securityIds: string[] = [];

const asAgent = () => ({ authorization: `Bearer ${agentToken}` });
const asApprover = () => ({ authorization: `Bearer ${approverToken}` });

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    COMPLIANCE_GATEWAY: "mock",
    CHAIN_GATEWAY: "mock",
    HTLC_TIMELOCK_SECONDS: 3600,
  };
  app = await buildServer(config);
  await app.ready();
  chainId = config.EIP712_CHAIN_ID;

  agentToken = await app.signToken("agent", "settle-test");
  approverToken = await app.signToken("approver", "settle-test");
  issuerToken = await app.signToken("issuer", "settle-test");

  const vendor = await prisma.vendor.create({
    data: {
      payeeType: "BUSINESS",
      legalEntityName: "Harbour Freight Systems Private Limited",
      country: "IN",
      verificationTier: "TIER2_IDENTITY",
    },
  });
  vendorId = vendor.id;

  walletId = (
    await prisma.vendorWallet.create({
      data: {
        vendorId,
        address: PAYEE.address,
        network: "hedera",
        // Names the token explicitly, so settlement does not have to guess
        // which contract a symbol refers to.
        tokenContract: TOKEN,
        version: 1,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  const settlements = await prisma.htlcSettlement.findMany({
    where: { paymentRequestId: { in: paymentIds } },
    select: { preimageEncryptedRef: true },
  });
  await prisma.htlcSettlement.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.recipientAcknowledgment.deleteMany({
    where: { paymentRequestId: { in: paymentIds } },
  });
  await prisma.exceptionCase.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.approvalEvent.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.proposal.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.encryptedBlob.deleteMany({
    where: {
      id: {
        in: settlements
          .map((s) => s.preimageEncryptedRef)
          .filter((id): id is string => Boolean(id)),
      },
    },
  });
  await prisma.securityEvent.deleteMany({ where: { securityId: { in: securityIds } } });
  await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app?.close();
  await prisma.$disconnect();
});

/**
 * A payment sitting where `settle` expects it: approved, with a proposal.
 *
 * Built through Prisma rather than the decision engine, because what is under
 * test is the release, and driving the full pipeline would make these cases
 * depend on tier thresholds and matcher scores that have their own suites.
 */
async function approvedPayment(mode: "DIRECT" | "HTLC", amount = "500.00"): Promise<string> {
  const payment = await prisma.paymentRequest.create({
    data: {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef: `INV-${Math.random().toString(36).slice(2, 10)}`,
      amount: new Prisma.Decimal(amount),
      token: "RCV",
      network: "hedera",
      settlementMode: mode,
      senderContextCommitment: `0x${"cd".repeat(32)}`,
      status: "AWAITING_APPROVAL",
      decision: "SAFE_TO_SEND",
      decisionReasonCode: "ALL_CHECKS_PASSED",
    },
  });
  paymentIds.push(payment.id);

  await prisma.proposal.create({
    data: { paymentRequestId: payment.id, proposedBy: "settle-test" },
  });
  return payment.id;
}

/** Gives the treasury units to spend, so a transfer or lock has something to move. */
async function fundTreasury(amount: string): Promise<void> {
  const chain = app.container.chainGateway;
  await chain.mint(TOKEN as `0x${string}`, chain.treasuryAddress, BigInt(amount));
}

const settle = (paymentId: string, headers = asApprover(), payload: object = {}) =>
  app.inject({ method: "POST", url: `/payments/${paymentId}/settle`, headers, payload });

async function signRelease(paymentId: string, lockId: string, signer = PAYEE) {
  return signer.signTypedData({
    domain: domainFor(chainId),
    types: SECRET_RELEASE_TYPES,
    primaryType: "SecretRelease",
    message: buildSecretReleaseMessage({
      paymentRequestId: paymentId,
      // Always the payout address: a stranger signing over their own address
      // would be signing a different message, not a forged one.
      recipientAddress: PAYEE.address,
      lockId,
    }),
  });
}

describe("who may release a payment", () => {
  it("refuses an agent token", async () => {
    const paymentId = await approvedPayment("DIRECT");
    const response = await settle(paymentId, asAgent());
    // Autonomous code proposes. It does not spend (D12). 401 rather than 403
    // because each role verifies against its own secret.
    expect(response.statusCode).toBe(401);
  });

  it("refuses a payment nobody approved", async () => {
    const paymentId = await approvedPayment("DIRECT");
    await prisma.paymentRequest.update({
      where: { id: paymentId },
      data: { status: "DECISION_PENDING" },
    });
    const response = await settle(paymentId);
    expect(response.statusCode).toBe(409);
  });

  it("refuses to release the same payment twice", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("DIRECT", "100.00");
    expect((await settle(paymentId)).statusCode).toBe(200);
    expect((await settle(paymentId)).statusCode).toBe(409);
  });
});

describe("direct settlement", () => {
  it("transfers, marks the payment sent and writes the evidence", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("DIRECT", "250.00");

    const response = await settle(paymentId);
    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe("DIRECT");
    expect(response.json().status).toBe("SENT");
    // Nothing was broadcast, and the response says so rather than leaving a
    // synthetic hash to be mistaken for a real one (D21).
    expect(response.json().broadcast).toBe(false);
    expect(response.json().settlement).toBeNull();

    const payment = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("SENT");
    expect(payment.txHash).toBe(response.json().txHash);

    const evidence = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: paymentId },
      orderBy: { createdAt: "asc" },
    });
    expect(evidence.map((e) => e.eventType)).toEqual(["approval", "send"]);
  });

  it("records that no device confirmed it", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("DIRECT", "50.00");
    await settle(paymentId);

    const approval = await prisma.approvalEvent.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    // Released by an approver token through the API. Reporting a device
    // confirmation here would misdescribe the custody model (D32).
    expect(approval.ledgerConfirmed).toBe(false);
  });

  it("consumes the proposal so it leaves the queue", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("DIRECT", "10.00");
    await settle(paymentId);

    const proposal = await prisma.proposal.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    expect(proposal.consumedAt).not.toBeNull();
  });
});

describe("escrow settlement", () => {
  it("locks the funds and returns the escrow", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", "300.00");

    const response = await settle(paymentId);
    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe("HTLC");

    const settlement = response.json().settlement;
    expect(settlement.status).toBe("LOCKED");
    expect(settlement.payeeAddress).toBe(PAYEE.address);
    expect(settlement.onChainAmount).toBe("30000");
    // Only the hash is published. The response must never carry the secret.
    expect(settlement.hashlock).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settlement.preimage).toBeNull();
    expect(JSON.stringify(response.json())).not.toContain("preimage\":\"0x");

    const evidence = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: paymentId },
      orderBy: { createdAt: "asc" },
    });
    expect(evidence.map((e) => e.eventType)).toEqual(["htlc_locked", "approval", "send"]);
  });

  it("stores the secret encrypted, never in the clear", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", "40.00");
    const settlement = (await settle(paymentId)).json().settlement;

    const row = await prisma.htlcSettlement.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
      include: { preimageBlob: true },
    });
    expect(row.preimageEncryptedRef).not.toBeNull();
    expect(row.preimageBlob?.kind).toBe("HTLC_PREIMAGE");
    // Unspent, so it is not in the settlement row and not in the evidence chain.
    expect(row.preimage).toBeNull();
    expect(settlement.preimage).toBeNull();
  });

  it("honours a caller-supplied timelock", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", "20.00");

    const response = await settle(paymentId, asApprover(), { timelockSeconds: 600 });
    const timelock = new Date(response.json().settlement.timelock).getTime();
    const expected = Date.now() + 600_000;
    expect(Math.abs(timelock - expected)).toBeLessThan(30_000);
  });

  it("debits the treasury, so the money really is in escrow", async () => {
    await fundTreasury("100000");
    const chain = app.container.chainGateway;
    const before = await chain.balanceOf(TOKEN as `0x${string}`, chain.treasuryAddress);

    const paymentId = await approvedPayment("HTLC", "100.00");
    await settle(paymentId);

    const after = await chain.balanceOf(TOKEN as `0x${string}`, chain.treasuryAddress);
    expect(before - after).toBe(10_000n);
  });
});

describe("releasing the secret", () => {
  async function lockedPayment(): Promise<{ paymentId: string; lockId: string }> {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", "60.00");
    const settlement = (await settle(paymentId)).json().settlement;
    return { paymentId, lockId: settlement.lockId };
  }

  it("gives the secret to the payee, and it matches the published hash", async () => {
    const { paymentId, lockId } = await lockedPayment();

    const response = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/settlement/secret`,
      headers: asAgent(),
      payload: { signature: await signRelease(paymentId, lockId) },
    });

    expect(response.statusCode).toBe(200);
    const preimage = response.json().preimage;
    const row = await prisma.htlcSettlement.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    // The secret the payee receives must open the lock the platform published.
    expect(hashlockFor(preimage).toLowerCase()).toBe(row.hashlock.toLowerCase());
    expect(row.preimageReleasedAt).not.toBeNull();
  });

  it("refuses a signature from anyone but the payee", async () => {
    const { paymentId, lockId } = await lockedPayment();

    const response = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/settlement/secret`,
      headers: asAgent(),
      payload: { signature: await signRelease(paymentId, lockId, STRANGER) },
    });

    // Whoever holds the preimage can take the money, so a valid API token is
    // deliberately not enough to obtain it (D41).
    expect(response.statusCode).toBe(422);
  });

  it("refuses a signature made for a different escrow", async () => {
    const first = await lockedPayment();
    const second = await lockedPayment();

    const response = await app.inject({
      method: "POST",
      url: `/payments/${second.paymentId}/settlement/secret`,
      headers: asAgent(),
      // Signed correctly by the payee, but over the first lock. The lock id is
      // in the payload precisely so this cannot be replayed.
      payload: { signature: await signRelease(second.paymentId, first.lockId) },
    });

    expect(response.statusCode).toBe(422);
  });

  it("refuses once the claim window has closed", async () => {
    const { paymentId, lockId } = await lockedPayment();
    await prisma.htlcSettlement.update({
      where: { paymentRequestId: paymentId },
      data: { timelock: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/settlement/secret`,
      headers: asAgent(),
      payload: { signature: await signRelease(paymentId, lockId) },
    });

    // The contract closes claiming at the timelock, so handing the secret over
    // would only make the payment look collectable.
    expect(response.statusCode).toBe(422);
  });
});

describe("refunding", () => {
  async function expiredLock(amount = "80.00"): Promise<string> {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", amount);
    await settle(paymentId);
    await prisma.htlcSettlement.update({
      where: { paymentRequestId: paymentId },
      data: { timelock: new Date(Date.now() - 1000) },
    });
    return paymentId;
  }

  it("returns the money and opens an exception", async () => {
    const chain = app.container.chainGateway;
    const paymentId = await expiredLock("80.00");
    const before = await chain.balanceOf(TOKEN as `0x${string}`, chain.treasuryAddress);

    const response = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/settlement/refund/execute`,
      headers: asApprover(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("REFUNDED");

    const after = await chain.balanceOf(TOKEN as `0x${string}`, chain.treasuryAddress);
    expect(after - before).toBe(8_000n);

    // The money coming back is the good outcome. A verified payee who never
    // collected an approved payment is not.
    const exception = await prisma.exceptionCase.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    expect(exception.type).toBe("MISDIRECT");

    const payment = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("EXCEPTION");
  });

  it("refuses before the deadline, as the contract does", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", "30.00");
    await settle(paymentId);

    const response = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/settlement/refund/execute`,
      headers: asApprover(),
    });
    expect(response.statusCode).toBe(422);
  });

  it("sweeps every expired escrow without being asked per payment", async () => {
    const first = await expiredLock("15.00");
    const second = await expiredLock("25.00");

    const response = await app.inject({
      method: "POST",
      url: "/settlement/sweep-refunds",
      headers: asAgent(),
    });

    expect(response.statusCode).toBe(200);
    const refunded = response.json().refunded.map((r: { paymentRequestId: string }) => r.paymentRequestId);
    // Without the sweep, recovery would depend on somebody remembering.
    expect(refunded).toContain(first);
    expect(refunded).toContain(second);
    expect(response.json().failed).toEqual([]);

    for (const id of [first, second]) {
      const row = await prisma.htlcSettlement.findUniqueOrThrow({
        where: { paymentRequestId: id },
      });
      expect(row.status).toBe("REFUNDED");
    }
  });

  it("leaves a lock that has not expired alone", async () => {
    await fundTreasury("100000");
    const paymentId = await approvedPayment("HTLC", "35.00");
    await settle(paymentId);

    await app.inject({ method: "POST", url: "/settlement/sweep-refunds", headers: asAgent() });

    const row = await prisma.htlcSettlement.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    expect(row.status).toBe("LOCKED");
  });
});
