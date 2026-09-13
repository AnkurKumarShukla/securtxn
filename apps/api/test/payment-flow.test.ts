import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
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
import { consentToPayment } from "./fixtures/consent.js";
import { clearWorldIdRows, passWorldIdCheck } from "./fixtures/worldid.js";
import { fixtureOracle } from "./fixtures/oracle.js";
import { createPayer } from "./fixtures/payer.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

let app: FastifyInstance;
let payerId: string;
let token: string;
const vendorIds: string[] = [];
const CHAIN_ID = base.HEDERA_CHAIN_ID;
const auth = () => ({ authorization: `Bearer ${token}` });

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
  payerId = await createPayer(prisma);
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
  // PayeeConsent, Notification and the World ID rows all hold Restrict FKs or
  // point at rows deleted below, so they go first.
  await prisma.payeeConsent.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.notification.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await clearWorldIdRows(prisma, vendorIds);
  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.approvalEvent.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.proposal.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
  // VerifiableCredential holds Restrict FKs to vendor and wallet, so it must
  // go first or the deletes below throw and leave rows for the next run.
  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (blobs.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobs } } });

  await app?.close();
  await prisma.$disconnect();
});

/** Walks a vendor all the way to a CONFIRMED wallet. */
/**
 * Onboards a vendor to a CONFIRMED wallet.
 *
 * `payee` is a parameter because "has this address been paid before?" is a
 * property of the ADDRESS across the whole system, not of one vendor — so a
 * test asserting first-payment behaviour has to own an address no other suite
 * has ever sent to. Everything else uses the shared Anvil key.
 */
async function onboardedVendor(
  entityName = "Meridian Components Private Limited",
  payee: PrivateKeyAccount = PAYEE,
) {
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
    payload: { address: payee.address, network: "ethereum" },
  });
  const { walletId, controlProofNonce } = wallet.json();

  const controlSig = await payee.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: WALLET_CONTROL_TYPES,
    primaryType: "WalletControlProof",
    message: buildWalletControlMessage({
      vendorId,
      walletAddress: payee.address,
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
  const bindingSig = await payee.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: IDENTITY_BINDING_TYPES,
    primaryType: "IdentityBinding",
    message: buildIdentityBindingMessage({
      onboardingSessionNonce: row.onboardingSessionNonce!,
      digilockerUserId: row.digilockerUserId!,
      walletAddress: payee.address,
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
      payerVendorId: payerId,
      intendedPayeeName: fixtureOracle().legalName,
      intendedPayeePan: fixtureOracle().pan,
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
    // A FRESH address, generated per run. The check is global by design — the
    // address is the risk unit, not the vendor — so reusing the shared Anvil
    // key would make this assertion depend on whether some other suite had
    // already sent to it, which is state this test does not control.
    const freshPayee = privateKeyToAccount(generatePrivateKey());
    const { vendorId, walletId } = await onboardedVendor(
      "Meridian Components Private Limited",
      freshPayee,
    );
    const payment = await createPayment(vendorId, walletId);

    expect(payment.status).toBe("DRAFT");
    expect(payment.senderContextCommitment).toMatch(/^0x[0-9a-f]{64}$/);

    // P4 gates P6: nothing about the payee is checked until they accept.
    await consentToPayment(app, prisma, payment.id, vendorId, freshPayee, auth);

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
    // Null since D62: digest matching is exact, so there is no score.
    expect(after.json().matchScore).toBeNull();
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

    // An unconfirmed wallet is now stopped one step EARLIER than it used to
    // be: consent has to be signed by the confirmed payout address, and this
    // address has not proved anything yet. That is the stronger refusal —
    // the payment never even reaches the identity check.
    await passWorldIdCheck(prisma, payerId, payment.id);
    const consent = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/request-consent`,
      headers: auth(),
    });
    expect(consent.statusCode).toBe(200);

    // The decision engine still has to refuse it, because a wallet can be
    // revoked between consent and decision. Forced through the gate here so
    // that branch is exercised end to end and not only as a unit test.
    await prisma.payeeConsent.create({
      data: { paymentRequestId: payment.id, decision: "ACCEPTED" },
    });
    await prisma.paymentRequest.update({
      where: { id: payment.id },
      data: { status: "DECISION_PENDING" },
    });

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

  it("REVERIFIES when the sender names a different company (D62)", async () => {
    // A genuine mismatch, which the previous version of this test could not
    // produce: it derived the "claim" from the payee's own record, so the two
    // sides were the same value and the check could never fail.
    const { vendorId, walletId } = await onboardedVendor();

    const created = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId,
        vendorWalletId: walletId,
        payerVendorId: payerId,
        // Right wallet, wrong company — the invoice-fraud shape.
        intendedPayeeName: "Completely Different Holdings",
        intendedPayeePan: fixtureOracle().pan,
        invoiceRef: `INV-MISMATCH-${Date.now()}`,
        amount: "100",
        token: "USDC",
        network: "ethereum",
      },
    });
    expect(created.statusCode).toBe(201);
    await consentToPayment(app, prisma, created.json().id, vendorId, PAYEE, auth);

    const decision = await app.inject({
      method: "POST",
      url: `/payments/${created.json().id}/run-decision`,
      headers: auth(),
    });

    const body = decision.json();
    expect(body.decision).toBe("REVERIFY");
    expect(body.reasonCode).toBe("VENDOR_MATCH_FAILED");
    expect(body.matchScore).toBeNull();
  });

  it("REVERIFIES when the sender names the right company but the wrong PAN", async () => {
    // Both fields must agree; a correct name alone must not carry it, because
    // company names are not unique.
    const { vendorId, walletId } = await onboardedVendor();

    const created = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId,
        vendorWalletId: walletId,
        payerVendorId: payerId,
        intendedPayeeName: fixtureOracle().legalName,
        intendedPayeePan: "ZZZZZ9999Z",
        invoiceRef: `INV-PAN-${Date.now()}`,
        amount: "100",
        token: "USDC",
        network: "ethereum",
      },
    });
    expect(created.statusCode).toBe(201);
    await consentToPayment(app, prisma, created.json().id, vendorId, PAYEE, auth);

    const decision = await app.inject({
      method: "POST",
      url: `/payments/${created.json().id}/run-decision`,
      headers: auth(),
    });
    expect(decision.json().decision).toBe("REVERIFY");
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
        payerVendorId: payerId,
        intendedPayeeName: fixtureOracle().legalName,
        intendedPayeePan: fixtureOracle().pan,
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
    await consentToPayment(app, prisma, payment.id, vendorId, PAYEE, auth);

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
        payerVendorId: "00000000-0000-4000-8000-000000000001",
        intendedPayeeName: "Anything Ltd",
        intendedPayeePan: "ABCDE1234F",
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
    await consentToPayment(app, prisma, payment.id, vendorId, PAYEE, auth);

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

    // Causal order, and every step of it: a live sender raised the payment, a
    // live payee accepted, the payee agreed to be checked, the check ran, a
    // verdict followed. A chain that showed a match before the consent
    // authorising it would be describing a system with no gate.
    expect(chain.records.map((r: { eventType: string }) => r.eventType)).toEqual([
      "world_id_check",
      "world_id_check",
      "payee_consent",
      "vendor_match",
      "decision",
    ]);
    expect(chain.records[0].previousRecordHash).toMatch(/^0{64}$/);
    for (let i = 1; i < chain.records.length; i += 1) {
      expect(chain.records[i].previousRecordHash).toBe(chain.records[i - 1].payloadHash);
    }
  });

  it("records the read itself, after answering it (D18)", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);
    await consentToPayment(app, prisma, payment.id, vendorId, PAYEE, auth);
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
    expect(first.json().records).toHaveLength(5);

    const second = await app.inject({
      method: "GET",
      url: `/payments/${payment.id}/evidence`,
      headers: auth(),
    });
    const records = second.json().records;
    expect(records).toHaveLength(6);
    expect(records[5].eventType).toBe("evidence_accessed");
    expect(records[5].payload.data.actorRole).toBe("agent");
    expect(second.json().chainValid).toBe(true);
  });

  it("reports chainValid:false at the right index when a row is corrupted", async () => {
    // §4.8's acceptance criterion, against a real database row.
    const { vendorId, walletId } = await onboardedVendor();
    const payment = await createPayment(vendorId, walletId);
    await consentToPayment(app, prisma, payment.id, vendorId, PAYEE, auth);
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

    // A record in the middle of the chain. Corrupting a middle link is the
    // case worth testing: the report has to name WHERE the chain broke, not
    // merely that it did.
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
