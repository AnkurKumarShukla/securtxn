import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { consentToPayment } from "./fixtures/consent.js";
import { clearWorldIdRows } from "./fixtures/worldid.js";
import { fixtureOracle } from "./fixtures/oracle.js";
import { createPayer } from "./fixtures/payer.js";
import {
  IDENTITY_BINDING_TYPES,
  WALLET_CONTROL_TYPES,
  buildIdentityBindingMessage,
  buildWalletControlMessage,
  domainFor,
} from "../src/lib/eip712.js";

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
let agentToken: string;
let approverToken: string;
let bridgeToken: string;
const vendorIds: string[] = [];
const CHAIN_ID = base.EIP712_CHAIN_ID;

const asAgent = () => ({ authorization: `Bearer ${agentToken}` });
const asApprover = () => ({ authorization: `Bearer ${approverToken}` });
const asBridge = () => ({ authorization: `Bearer ${bridgeToken}` });

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
    IDENTITY_PROVIDER: "mock",
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
  };
  app = await buildServer(config);
  await app.ready();
  agentToken = await app.signToken("agent", "approval-flow-agent");
  approverToken = await app.signToken("approver", "operator-1");
  bridgeToken = await app.signToken("bridge", "bridge-daemon");
  payerId = await createPayer(prisma);
});

afterAll(async () => {
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
  await prisma.paymentRequest.deleteMany({ where: { id: { in: paymentIds } } });

  const blobs = (
    await prisma.vendor.findMany({
      where: { id: { in: vendorIds } },
      select: { photoEncryptedRef: true },
    })
  )
    .map((v) => v.photoEncryptedRef)
    .filter((id): id is string => id !== null);

  // VerifiableCredential holds Restrict FKs to vendor and wallet, so it must
  // go first or the deletes below throw and leave rows for the next run.
  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (blobs.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobs } } });

  await app?.close();
  await prisma.$disconnect();
});

/**
 * Onboards a vendor to a CONFIRMED wallet.
 *
 * `payee` is a parameter because "has this address been paid before?" is a
 * property of the ADDRESS across the whole system, not of one vendor. A test
 * asserting first-payment behaviour has to own an address no other suite has
 * sent to, or it passes or fails on whichever suites ran before it.
 */
async function onboardedVendor(
  entityName = "Meridian Components Private Limited",
  payee: PrivateKeyAccount = PAYEE,
) {
  const created = await app.inject({
    method: "POST",
    url: "/vendors",
    headers: asAgent(),
    payload: { payeeType: "BUSINESS", legalEntityName: entityName, country: "IN" },
  });
  const vendorId = created.json().id as string;
  vendorIds.push(vendorId);

  await prisma.vendor.updateMany({
    where: { digilockerUserId: { not: null }, id: { not: vendorId } },
    data: { digilockerUserId: null },
  });
  const session = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/session`,
    headers: asAgent(),
    payload: { docTypes: ["aadhaar", "pan"] },
  });
  await app.inject({
    method: "GET",
    url: `/dev/identity/consent?session_id=${session.json().sessionId}`,
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/complete`,
    headers: asAgent(),
  });

  const wallet = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets`,
    headers: asAgent(),
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
    headers: asAgent(),
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
    headers: asAgent(),
    payload: { signature: bindingSig },
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/callback-confirm`,
    headers: asAgent(),
    payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
  });

  return { vendorId, walletId };
}

/** A payment that has cleared the decision engine and may be queued. */
async function approvablePayment(payee: PrivateKeyAccount = PAYEE): Promise<string> {
  const { vendorId, walletId } = await onboardedVendor(
    "Meridian Components Private Limited",
    payee,
  );
  const created = await app.inject({
    method: "POST",
    url: "/payments",
    headers: asAgent(),
    payload: {
      vendorId,
      vendorWalletId: walletId,
      payerVendorId: payerId,
      intendedPayeeName: fixtureOracle().legalName,
      intendedPayeePan: fixtureOracle().pan,
      invoiceRef: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      amount: "12500.5",
      token: "USDC",
      network: "ethereum",
    },
  });
  const paymentId = created.json().id as string;

  // P4 gates P6: the payee has to accept before their identity is checked.
  await consentToPayment(app, prisma, paymentId, vendorId, payee, asAgent);
  await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/run-decision`,
    headers: asAgent(),
  });
  return paymentId;
}

describe("the boundary (D12)", () => {
  it("rejects an agent token on every /approvals route", async () => {
    // The single most important assertion in the system: autonomous code
    // cannot reach the approval surface. 401 rather than 403 — the agent
    // secret cannot produce a signature the approver verifier accepts, so it
    // fails before any role string is compared.
    const pending = await app.inject({
      method: "GET",
      url: "/approvals/pending",
      headers: asAgent(),
    });
    expect(pending.statusCode).toBe(401);

    const report = await app.inject({
      method: "POST",
      url: "/approvals/00000000-0000-4000-8000-000000000009/report-sent",
      headers: asAgent(),
      payload: {
        txHash: `0x${"ab".repeat(32)}`,
        ledgerConfirmedAt: new Date().toISOString(),
        approverId: "x",
      },
    });
    expect(report.statusCode).toBe(401);
  });

  it("rejects an approver token on propose", async () => {
    // And the reverse: the role that approves cannot queue work for itself.
    const res = await app.inject({
      method: "POST",
      url: "/payments/00000000-0000-4000-8000-000000000003/propose",
      headers: asApprover(),
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts both approver and bridge identities on the queue", async () => {
    for (const headers of [asApprover(), asBridge()]) {
      const res = await app.inject({ method: "GET", url: "/approvals/pending", headers });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe.skipIf(!hasRealFixtures)("proposal to send", () => {
  it("refuses to queue a payment the engine did not clear", async () => {
    // A DO_NOT_SEND payment reaching the approver's terminal is how a human
    // ends up rubber-stamping something already refused.
    const created = await app.inject({
      method: "POST",
      url: "/vendors",
      headers: asAgent(),
      payload: { payeeType: "BUSINESS", legalEntityName: "Blocked Co", country: "IN" },
    });
    const vendorId = created.json().id as string;
    vendorIds.push(vendorId);

    const wallet = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/wallets`,
      headers: asAgent(),
      payload: { address: PAYEE.address, network: "ethereum" },
    });
    const payment = await app.inject({
      method: "POST",
      url: "/payments",
      headers: asAgent(),
      payload: {
        vendorId,
        vendorWalletId: wallet.json().walletId,
        payerVendorId: payerId,
        // A truthful claim: the payment is refused for the vendor being
        // unverified, not for the sender naming the wrong payee.
        intendedPayeeName: "Blocked Co",
        intendedPayeePan: "BLOCK1234C",
        invoiceRef: "INV-BLOCKED",
        amount: "10",
        token: "USDC",
        network: "ethereum",
      },
    });
    const paymentId = payment.json().id as string;
    await consentToPayment(app, prisma, paymentId, vendorId, PAYEE, asAgent);
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/run-decision`,
      headers: asAgent(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/propose`,
      headers: asAgent(),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("runs proposal to SENT with a chain that still verifies", async () => {
    // A fresh address per run: this asserts `isNewOrChangedAddress`, and the
    // shared Anvil key has been paid by other suites in the same run.
    const paymentId = await approvablePayment(privateKeyToAccount(generatePrivateKey()));

    const proposed = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/propose`,
      headers: asAgent(),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const proposal = proposed.json();
    expect(proposal.isNewOrChangedAddress).toBe(true);

    const queue = await app.inject({
      method: "GET",
      url: "/approvals/pending",
      headers: asBridge(),
    });
    const queued = queue.json().proposals.find((p: { id: string }) => p.id === proposal.id);
    expect(queued).toBeDefined();
    // Enough to recognise the payee, and nothing more (D06).
    expect(queued.vendorName).toBeTruthy();
    expect(queued).not.toHaveProperty("aadhaarLast4");

    const txHash = `0x${"cd".repeat(32)}`;
    const reported = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/report-sent`,
      headers: asBridge(),
      payload: { txHash, ledgerConfirmedAt: new Date().toISOString(), approverId: "operator-1" },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({ status: "SENT", txHash });

    const after = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}`,
      headers: asAgent(),
    });
    expect(after.json().status).toBe("SENT");
    expect(after.json().txHash).toBe(txHash);

    const evidence = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}/evidence`,
      headers: asAgent(),
    });
    // The full life of a payment, in causal order: both parties proved they
    // were live humans, the payee agreed to be checked, the check ran, a
    // verdict followed, a human approved it, the money went. Each record is
    // written by a different actor, and the chain is the only place that
    // order is provable after the fact.
    expect(evidence.json().records.map((r: { eventType: string }) => r.eventType)).toEqual([
      "world_id_check",
      "world_id_check",
      "payee_consent",
      "vendor_match",
      "decision",
      "approval",
      "send",
    ]);
    expect(evidence.json().chainValid).toBe(true);
  });

  it("removes a consumed proposal from the queue and refuses a double send", async () => {
    const paymentId = await approvablePayment();
    const proposed = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/propose`,
      headers: asAgent(),
      payload: {},
    });
    const proposalId = proposed.json().id as string;
    const body = {
      txHash: `0x${"ef".repeat(32)}`,
      ledgerConfirmedAt: new Date().toISOString(),
      approverId: "operator-1",
    };

    const first = await app.inject({
      method: "POST",
      url: `/approvals/${proposalId}/report-sent`,
      headers: asApprover(),
      payload: body,
    });
    expect(first.statusCode).toBe(200);

    const queue = await app.inject({
      method: "GET",
      url: "/approvals/pending",
      headers: asApprover(),
    });
    expect(queue.json().proposals.map((p: { id: string }) => p.id)).not.toContain(proposalId);

    // Reporting twice would produce two ApprovalEvents and two send records
    // for a single payment.
    const second = await app.inject({
      method: "POST",
      url: `/approvals/${proposalId}/report-sent`,
      headers: asApprover(),
      payload: body,
    });
    expect(second.statusCode).toBe(409);
  });

  it("refuses to propose the same payment twice", async () => {
    const paymentId = await approvablePayment();
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/propose`,
      headers: asAgent(),
      payload: {},
    });
    const again = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/propose`,
      headers: asAgent(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });
});
