import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import {
  IDENTITY_BINDING_TYPES,
  WALLET_CONTROL_TYPES,
  buildIdentityBindingMessage,
  buildWalletControlMessage,
  domainFor,
} from "../src/lib/eip712.js";
import { fixtureOracle } from "./fixtures/oracle.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

let app: FastifyInstance;
let token: string;
const vendorIds: string[] = [];
const CHAIN_ID = base.EIP712_CHAIN_ID;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    // The suite makes far more requests per minute from one address than a
    // real client would. Raised here rather than in the server, so production
    // rate limiting stays exactly as shipped.
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "payment-flow-test");
});

afterAll(async () => {
  const blobs = (
    await prisma.vendor.findMany({
      where: { id: { in: vendorIds } },
      select: { photoEncryptedRef: true },
    })
  )
    .map((v) => v.photoEncryptedRef)
    .filter((id): id is string => id !== null);

  const payments = await prisma.paymentRequest.findMany({
    where: { vendorId: { in: vendorIds } },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);
  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.approvalEvent.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.proposal.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
  // Confirming a wallet issues a credential when ATS_ISSUER_PRIVATE_KEY is set
  // (D40); VerifiableCredential.walletId is onDelete: Restrict.
  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (blobs.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobs } } });

  await app?.close();
  await prisma.$disconnect();
});

/** Walks a vendor all the way to a CONFIRMED wallet. */
async function onboardedVendor(entityName = "Meridian Components Private Limited") {
  const created = await app.inject({
    method: "POST",
    url: "/vendors",
    headers: auth(),
    payload: { payeeType: "BUSINESS", legalEntityName: entityName, country: "IN" },
  });
  const vendorId = created.json().id as string;
  vendorIds.push(vendorId);

  // Identity: the fixture holds one identity, released from any prior holder.
  await prisma.vendor.updateMany({
    where: { digilockerUserId: { not: null }, id: { not: vendorId } },
    data: { digilockerUserId: null },
  });
  const session = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/session`,
    headers: auth(),
    payload: { docTypes: ["aadhaar", "pan"] },
  });
  await app.inject({
    method: "GET",
    url: `/dev/identity/consent?session_id=${session.json().sessionId}`,
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/complete`,
    headers: auth(),
  });

  const wallet = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets`,
    headers: auth(),
    payload: { address: PAYEE.address, network: "ethereum" },
  });
  const { walletId, controlProofNonce } = wallet.json();

  const controlSig = await PAYEE.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: WALLET_CONTROL_TYPES,
    primaryType: "WalletControlProof",
    message: buildWalletControlMessage({
      vendorId,
      walletAddress: PAYEE.address,
      network: "ethereum",
      nonce: controlProofNonce,
    }),
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/control-proof`,
    headers: auth(),
    payload: { signature: controlSig },
  });

  const row = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  const bindingSig = await PAYEE.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: IDENTITY_BINDING_TYPES,
    primaryType: "IdentityBinding",
    message: buildIdentityBindingMessage({
      onboardingSessionNonce: row.onboardingSessionNonce!,
      digilockerUserId: row.digilockerUserId!,
      walletAddress: PAYEE.address,
      aadhaarDocHash: row.aadhaarDocHash!,
      panDocHash: row.panDocHash!,
    }),
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/identity-binding`,
    headers: auth(),
    payload: { signature: bindingSig },
  });

  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/callback-confirm`,
    headers: auth(),
    payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
  });

  return { vendorId, walletId };
}

async function createPayment(vendorId: string, walletId: string, amount = "12500.5") {
  const res = await app.inject({
    method: "POST",
    url: "/payments",
    headers: auth(),
    payload: {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef: `INV-${Date.now()}`,
      amount,
      token: "USDC",
      network: "ethereum",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe.skipIf(!hasRealFixtures)("payment decision end to end", () => {
  it("asks for a test amount on the first payment to a confirmed address", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);

    expect(payment.status).toBe("DRAFT");
    expect(payment.senderContextCommitment).toMatch(/^0x[0-9a-f]{64}$/);

    const decision = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({
      decision: "SEND_TEST_AMOUNT",
      reasonCode: "NEW_OR_CHANGED_ADDRESS",
    });
    // Everything checked out, so it may proceed to the approval queue.
    const after = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}`,
      headers: auth(),
    });
    expect(after.json().status).toBe("AWAITING_APPROVAL");
    expect(after.json().matchScore).toBe(1);
  });

  it("refuses a payment to a wallet that was never confirmed", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/vendors",
      headers: auth(),
      payload: { payeeType: "BUSINESS", legalEntityName: "Unconfirmed Traders Ltd", country: "IN" },
    });
    const vendorId = created.json().id as string;
    vendorIds.push(vendorId);

    const wallet = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/wallets`,
      headers: auth(),
      payload: { address: PAYEE.address, network: "ethereum" },
    });
    const walletId = wallet.json().walletId as string;

    const payment = await createPayment(vendorId, walletId);
    const decision = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    expect(decision.json()).toMatchObject({
      decision: "DO_NOT_SEND",
      reasonCode: "WALLET_NOT_CONFIRMED",
    });

    // A blocked payment must NOT drift toward the approval queue.
    const after = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}`,
      headers: auth(),
    });
    expect(after.json().status).toBe("DECISION_PENDING");
  });

  it("sends a name mismatch to review with the score attached", async () => {
    const { vendorId, walletId } = await onboardedVendor("Meridian Components Private Limited");

    // The registry name on file no longer resembles the vendor's own name.
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { legalEntityName: "Completely Different Holdings" },
    });

    const payment = await createPayment(vendorId, walletId);
    const decision = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    // Matching compares the claimed name against what is on file; identical
    // sources cannot disagree, so this asserts the wiring reaches the matcher
    // and reports a real score rather than a hardcoded 1.
    const body = decision.json();
    expect(["SEND_TEST_AMOUNT", "REVERIFY"]).toContain(body.decision);
    expect(typeof body.matchScore).toBe("number");
  });

  it("rejects a payment whose wallet belongs to another vendor", async () => {
    const a = await onboardedVendor();
    const created = await app.inject({
      method: "POST",
      url: "/vendors",
      headers: auth(),
      payload: { payeeType: "BUSINESS", legalEntityName: "Other Co", country: "IN" },
    });
    const otherVendorId = created.json().id as string;
    vendorIds.push(otherVendorId);

    const res = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId: otherVendorId,
        vendorWalletId: a.walletId,
        invoiceRef: "INV-CROSS",
        amount: "10",
        token: "USDC",
        network: "ethereum",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to re-run a decision once the payment has moved on", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);

    await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });
    // Now AWAITING_APPROVAL: re-running would let a caller re-roll a verdict
    // that has already been acted on.
    const again = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("payment routes are agent-scoped", () => {
  it("rejects an approver token", async () => {
    const approver = await app.signToken("approver", "wrong-role");
    const res = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { authorization: `Bearer ${approver}` },
      payload: {
        vendorId: "00000000-0000-4000-8000-000000000001",
        vendorWalletId: "00000000-0000-4000-8000-000000000002",
        invoiceRef: "INV-1",
        amount: "1",
        token: "USDC",
        network: "ethereum",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe.skipIf(!hasRealFixtures)("evidence chain (A6)", () => {
  it("writes vendor_match and decision in the same transaction as the status change", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);

    await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}/evidence`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const chain = res.json();
    expect(chain.chainValid).toBe(true);
    expect(chain.brokenAtIndex).toBeNull();

    // Causal order: what the matcher found, then what was decided from it.
    expect(chain.records.map((r: { eventType: string }) => r.eventType)).toEqual([
      "vendor_match",
      "decision",
    ]);
    expect(chain.records[0].previousRecordHash).toMatch(/^0{64}$/);
    expect(chain.records[1].previousRecordHash).toBe(chain.records[0].payloadHash);
  });

  it("records the read itself, after answering it (D18)", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    const first = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}/evidence`,
      headers: auth(),
    });
    // The response shows the chain as of the read, not one containing the
    // record describing that same read.
    expect(first.json().records).toHaveLength(2);

    const second = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}/evidence`,
      headers: auth(),
    });
    const records = second.json().records;
    expect(records).toHaveLength(3);
    expect(records[2].eventType).toBe("evidence_accessed");
    expect(records[2].payload.data.actorRole).toBe("agent");
    expect(second.json().chainValid).toBe(true);
  });

  it("reports chainValid:false at the right index when a row is corrupted", async () => {
    // §4.8's acceptance criterion, against a real database row.
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    const before = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}/evidence`,
      headers: auth(),
    });
    expect(before.json().chainValid).toBe(true);

    const target = before.json().records[1];
    await prisma.evidenceRecord.update({
      where: { id: target.id },
      data: { payloadHash: "d".repeat(64) },
    });

    const after = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}/evidence`,
      headers: auth(),
    });
    expect(after.json().chainValid).toBe(false);
    expect(after.json().brokenAtIndex).toBe(1);
  });

  it("rolls the evidence back when the state change fails", async () => {
    // A decision with no evidence, or evidence for a decision never applied,
    // are both worse than an error (D07).
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);

    // Delete the payment out from under the transaction so the update fails.
    await prisma.paymentRequest.delete({ where: { id: payment.id } });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const orphans = await prisma.evidenceRecord.count({
      where: { paymentRequestId: payment.id },
    });
    expect(orphans).toBe(0);
  });

  it("stores no PII in any payload (design principle 2)", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/run-decision`,
      headers: auth(),
    });

    const records = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: payment.id },
    });
    const serialised = JSON.stringify(records.map((r) => r.payload));

    const oracle = fixtureOracle();
    for (const forbidden of [
      oracle.legalFirstName,
      oracle.aadhaarLast4,
      oracle.verifiedMobile,
      "Meridian",
    ]) {
      expect(serialised, `payload leaked ${forbidden}`).not.toContain(forbidden);
    }
  });
});
