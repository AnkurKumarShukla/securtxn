import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import {
  ACK_TYPES,
  IDENTITY_BINDING_TYPES,
  WALLET_CONTROL_TYPES,
  buildAcknowledgmentMessage,
  buildIdentityBindingMessage,
  buildWalletControlMessage,
  domainFor,
} from "../src/lib/eip712.js";
import { decide } from "../src/modules/decision/index.js";
import { playbookFor } from "../src/modules/exceptions/playbooks.js";
import { Prisma } from "@prisma/client";
import type { DecisionInput, TierThresholds } from "../src/modules/decision/types.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const OTHER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
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
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
    COMPLIANCE_GATEWAY: "mock",
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "exception-flow-test");
});

afterAll(async () => {
  const payments = await prisma.paymentRequest.findMany({
    where: { vendorId: { in: vendorIds } },
    select: { id: true, recipientAck: { select: { rawContextEncryptedRef: true } } },
  });
  const paymentIds = payments.map((p) => p.id);
  const ackBlobs = payments
    .map((p) => p.recipientAck?.rawContextEncryptedRef)
    .filter((id): id is string => Boolean(id));

  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.exceptionCase.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.recipientAcknowledgment.deleteMany({
    where: { paymentRequestId: { in: paymentIds } },
  });
  await prisma.approvalEvent.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.proposal.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { id: { in: paymentIds } } });

  const vendorBlobs = (
    await prisma.vendor.findMany({
      where: { id: { in: vendorIds } },
      select: { photoEncryptedRef: true },
    })
  )
    .map((v) => v.photoEncryptedRef)
    .filter((id): id is string => Boolean(id));

  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.encryptedBlob.deleteMany({ where: { id: { in: [...ackBlobs, ...vendorBlobs] } } });

  await app?.close();
  await prisma.$disconnect();
});

async function onboardedVendor() {
  const created = await app.inject({
    method: "POST",
    url: "/vendors",
    headers: auth(),
    payload: { payeeType: "BUSINESS", legalEntityName: "Meridian Components Private Limited", country: "IN" },
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

  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/control-proof`,
    headers: auth(),
    payload: {
      signature: await PAYEE.signTypedData({
        domain: domainFor(CHAIN_ID),
        types: WALLET_CONTROL_TYPES,
        primaryType: "WalletControlProof",
        message: buildWalletControlMessage({
          vendorId,
          walletAddress: PAYEE.address,
          network: "ethereum",
          nonce: controlProofNonce,
        }),
      }),
    },
  });

  const row = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/identity-binding`,
    headers: auth(),
    payload: {
      signature: await PAYEE.signTypedData({
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
      }),
    },
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/callback-confirm`,
    headers: auth(),
    payload: { confirmedBy: "operator-1", channelUsed: "9793953201" },
  });

  return { vendorId, walletId };
}

async function sentPayment(vendorId: string, walletId: string, invoiceRef: string) {
  const created = await app.inject({
    method: "POST",
    url: "/payments",
    headers: auth(),
    payload: {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef,
      amount: "12500.5",
      token: "USDC",
      network: "ethereum",
    },
  });
  const paymentId = created.json().id as string;

  await app.inject({ method: "POST", url: `/payments/${paymentId}/run-decision`, headers: auth() });
  const proposed = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/propose`,
    headers: auth(),
    payload: {},
  });
  const approver = await app.signToken("approver", "operator-1");
  await app.inject({
    method: "POST",
    url: `/approvals/${proposed.json().id}/report-sent`,
    headers: { authorization: `Bearer ${approver}` },
    payload: {
      txHash: `0x${"ab".repeat(32)}`,
      ledgerConfirmedAt: new Date().toISOString(),
      approverId: "operator-1",
    },
  });
  return paymentId;
}

// ---------------------------------------------------------------------------

describe("duplicate payments are a hard block", () => {
  const thresholds: TierThresholds = { maxAmountForTier: () => null };
  const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
    vendorWallet: { status: "CONFIRMED", address: PAYEE.address, network: "ethereum" },
    verificationTier: "TIER3_ADDRESS",
    matchResult: { match: true, score: 1, reasonCode: "MATCHED" },
    sanctionsHit: false,
    isDuplicate: false,
    isNewOrChangedAddress: false,
    amount: new Prisma.Decimal("100"),
    ...over,
  });

  it("blocks a duplicate even for a fully verified payee", () => {
    const result = decide(input({ isDuplicate: true }), thresholds);
    expect(result.decision).toBe("DO_NOT_SEND");
    expect(result.reasonCode).toBe("DUPLICATE_PAYMENT");
  });

  it("still reports a sanctions hit ahead of a duplicate", () => {
    // Precedence stays intact: the most severe finding is what lands in the
    // evidence chain (D35).
    const result = decide(input({ isDuplicate: true, sanctionsHit: true }), thresholds);
    expect(result.reasonCode).toBe("SANCTIONS_HIT");
  });
});

describe("playbooks", () => {
  it("seeds ordered, concrete steps for every exception type", () => {
    for (const type of ["OVERPAY", "MISDIRECT", "DUPLICATE", "WRONG_ASSET", "DISPUTE"] as const) {
      const steps = playbookFor(type);
      expect(steps.length, type).toBeGreaterThan(2);
      expect(steps.every((s) => s.status === "PENDING")).toBe(true);
    }
  });

  it("puts freezing further payments first for a misdirect", () => {
    // Ordering is the value: stop the bleeding before investigating.
    expect(playbookFor("MISDIRECT")[0]?.step).toMatch(/freeze/i);
  });
});

describe.skipIf(!hasRealFixtures)("exception desk", () => {
  it("auto-opens a DUPLICATE case and blocks before the approval queue", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const invoiceRef = `INV-DUP-${Date.now()}`;
    await sentPayment(vendorId, walletId, invoiceRef);

    // Same vendor, same invoice reference, raised again.
    const second = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId,
        vendorWalletId: walletId,
        invoiceRef,
        amount: "12500.5",
        token: "USDC",
        network: "ethereum",
      },
    });
    const duplicateId = second.json().id as string;

    const decision = await app.inject({
      method: "POST",
      url: `/payments/${duplicateId}/run-decision`,
      headers: auth(),
    });
    expect(decision.json()).toMatchObject({
      decision: "DO_NOT_SEND",
      reasonCode: "DUPLICATE_PAYMENT",
    });

    // Blocked BEFORE the approval queue — it must never reach a human to sign.
    const after = await app.inject({
      method: "GET",
      url: `/payments/${duplicateId}`,
      headers: auth(),
    });
    expect(after.json().status).toBe("DECISION_PENDING");

    const proposed = await app.inject({
      method: "POST",
      url: `/payments/${duplicateId}/propose`,
      headers: auth(),
      payload: {},
    });
    expect(proposed.statusCode).toBe(422);

    // And a case was opened with its playbook.
    const cases = await app.inject({ method: "GET", url: "/exceptions", headers: auth() });
    const opened = cases.json().find((c: { paymentRequestId: string }) => c.paymentRequestId === duplicateId);
    expect(opened).toBeDefined();
    expect(opened.type).toBe("DUPLICATE");
    expect(opened.status).toBe("OPEN");
    expect(opened.playbookSteps.length).toBeGreaterThan(2);

    // The case is in the evidence chain too.
    const evidence = await app.inject({
      method: "GET",
      url: `/payments/${duplicateId}/evidence`,
      headers: auth(),
    });
    expect(evidence.json().records.map((r: { eventType: string }) => r.eventType)).toContain(
      "exception_opened",
    );
    expect(evidence.json().chainValid).toBe(true);
  });

  it("advances playbook steps and closes the case", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const paymentId = await sentPayment(vendorId, walletId, `INV-EXC-${Date.now()}`);

    const opened = await app.inject({
      method: "POST",
      url: "/exceptions",
      headers: auth(),
      payload: { paymentRequestId: paymentId, type: "MISDIRECT", openedBy: "operator-1" },
    });
    expect(opened.statusCode).toBe(201);
    const caseId = opened.json().id as string;

    const steps = opened.json().playbookSteps.map((s: { step: string }, i: number) => ({
      step: s.step,
      status: i === 0 ? "DONE" : "PENDING",
      ...(i === 0 ? { note: "payments frozen" } : {}),
    }));

    const patched = await app.inject({
      method: "PATCH",
      url: `/exceptions/${caseId}`,
      headers: auth(),
      payload: { status: "IN_RECOVERY", playbookSteps: steps },
    });
    expect(patched.json().status).toBe("IN_RECOVERY");
    expect(patched.json().playbookSteps[0].status).toBe("DONE");

    const resolved = await app.inject({
      method: "PATCH",
      url: `/exceptions/${caseId}`,
      headers: auth(),
      payload: { status: "RESOLVED" },
    });
    expect(resolved.json().resolvedAt).toBeTruthy();

    // A closed case is part of the record; reopening by mutation would erase
    // what was decided.
    const reopen = await app.inject({
      method: "PATCH",
      url: `/exceptions/${caseId}`,
      headers: auth(),
      payload: { status: "OPEN" },
    });
    expect(reopen.statusCode).toBe(409);
  });

  it("refuses a second open case for the same payment", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const paymentId = await sentPayment(vendorId, walletId, `INV-ONE-${Date.now()}`);

    const first = await app.inject({
      method: "POST",
      url: "/exceptions",
      headers: auth(),
      payload: { paymentRequestId: paymentId, type: "OVERPAY", openedBy: "operator-1" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/exceptions",
      headers: auth(),
      payload: { paymentRequestId: paymentId, type: "DISPUTE", openedBy: "operator-1" },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe.skipIf(!hasRealFixtures)("recipient acknowledgment", () => {
  const context = {
    invoiceRef: "INV-ACK",
    amount: "12500.5",
    token: "USDC",
    txHash: `0x${"ab".repeat(32)}`,
  };

  async function sign(paymentId: string, signer: typeof PAYEE, commitment: string) {
    return signer.signTypedData({
      domain: domainFor(CHAIN_ID),
      types: ACK_TYPES,
      primaryType: "RecipientAcknowledgment",
      message: buildAcknowledgmentMessage({
        paymentRequestId: paymentId,
        recipientAddress: signer.address,
        commitment,
      }),
    });
  }

  /** Same canonicalisation the server uses: sorted keys. */
  function commitmentFor(ctx: Record<string, unknown>): string {
    return keccak256(
      toHex(JSON.stringify(Object.fromEntries(Object.entries(ctx).sort(([a], [b]) => (a < b ? -1 : 1))))),
    );
  }

  it("accepts a signature from the address the money went to", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const paymentId = await sentPayment(vendorId, walletId, `INV-ACK-${Date.now()}`);
    const commitment = commitmentFor(context);

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/acknowledgment`,
      headers: auth(),
      payload: {
        recipientAddress: PAYEE.address,
        recipientSignature: await sign(paymentId, PAYEE, commitment),
        acknowledgedContext: context,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().recipientCommitment).toBe(commitment);

    // The raw context is encrypted, and only the commitment is in evidence.
    const ack = await prisma.recipientAcknowledgment.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    expect(ack.rawContextEncryptedRef).toBeTruthy();
    const blob = await prisma.encryptedBlob.findUniqueOrThrow({
      where: { id: ack.rawContextEncryptedRef! },
    });
    expect(blob.kind).toBe("ACK_CONTEXT");

    const evidence = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}/evidence`,
      headers: auth(),
    });
    const ackRecord = evidence
      .json()
      .records.find((r: { eventType: string }) => r.eventType === "ack");
    expect(ackRecord.payload.data.recipientCommitment).toBe(commitment);
    expect(JSON.stringify(ackRecord.payload)).not.toContain("INV-ACK");
    expect(evidence.json().chainValid).toBe(true);
  });

  it("rejects a signature from anyone else", async () => {
    // Otherwise a third party could manufacture a receipt for someone's payment.
    const { vendorId, walletId } = await onboardedVendor();
    const paymentId = await sentPayment(vendorId, walletId, `INV-ACK2-${Date.now()}`);
    const commitment = commitmentFor(context);

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/acknowledgment`,
      headers: auth(),
      payload: {
        recipientAddress: OTHER.address,
        recipientSignature: await sign(paymentId, OTHER, commitment),
        acknowledgedContext: context,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/sent to/i);
  });

  it("rejects a signature over a different context", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const paymentId = await sentPayment(vendorId, walletId, `INV-ACK3-${Date.now()}`);

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/acknowledgment`,
      headers: auth(),
      payload: {
        recipientAddress: PAYEE.address,
        // Signed over a different amount than the one submitted.
        recipientSignature: await sign(paymentId, PAYEE, commitmentFor({ ...context, amount: "1" })),
        acknowledgedContext: context,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses to acknowledge a payment that was never sent", async () => {
    const { vendorId, walletId } = await onboardedVendor();
    const created = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId,
        vendorWalletId: walletId,
        invoiceRef: `INV-DRAFT-${Date.now()}`,
        amount: "1",
        token: "USDC",
        network: "ethereum",
      },
    });
    const paymentId = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/acknowledgment`,
      headers: auth(),
      payload: {
        recipientAddress: PAYEE.address,
        recipientSignature: await sign(paymentId, PAYEE, commitmentFor(context)),
        acknowledgedContext: context,
      },
    });
    expect(res.statusCode).toBe(422);
  });
});
