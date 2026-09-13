// P3-P5 end to end: the payee is asked, and nothing is checked until they say yes.
//
// The property under test is not "consent is recorded" — it is that consent
// cannot be skipped, forged, transferred or replayed, because the identity
// match behind it is the only thing in this system that will tell a stranger
// whether an address belongs to a given PAN.
//
// Spec: docs/payment-flow.md (P3-P5)

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
  PAYEE_CONSENT_TYPES,
  WALLET_CONTROL_TYPES,
  buildIdentityBindingMessage,
  buildPayeeConsentMessage,
  buildWalletControlMessage,
  domainFor,
} from "../src/lib/eip712.js";
import { acceptPayment, denyPayment } from "./fixtures/consent.js";
import { fixtureOracle } from "./fixtures/oracle.js";
import { createPayer } from "./fixtures/payer.js";
import { clearWorldIdRows, enrolSubject, passWorldIdCheck } from "./fixtures/worldid.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

/** Anvil #1 — the payee. */
const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
/** Anvil #2 — a key that is not the payee's, for the substitution tests. */
const STRANGER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
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
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "consent-flow-test");
  payerId = await createPayer(prisma);
  vendorIds.push(payerId);
  await enrolSubject(prisma, payerId);
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

  await prisma.payeeConsent.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.notification.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.identityBlock.deleteMany({ where: { blockedByVendorId: { in: vendorIds } } });
  await prisma.paymentRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await clearWorldIdRows(prisma, vendorIds);
  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (blobs.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobs } } });

  await app?.close();
  await prisma.$disconnect();
});

/** A vendor with a CONFIRMED wallet and a World ID enrolment (O1-O7). */
async function onboardedPayee(entityName = "Meridian Components Private Limited") {
  const created = await app.inject({
    method: "POST",
    url: "/vendors",
    headers: auth(),
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
    payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
  });

  // O7. Without it every payment trips NOT_ENROLLED, which is correct
  // behaviour and would drown out the rule each test is actually about.
  await enrolSubject(prisma, vendorId);

  return { vendorId, walletId };
}

async function draftPayment(vendorId: string, walletId: string, amount = "1250.50") {
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
      invoiceRef: `INV-CONSENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      amount,
      token: "USDC",
      network: "ethereum",
    },
  });
  const paymentId = res.json().id as string;

  // P2 — the sender's own Selfie Check, bound to this payment. It happens
  // immediately after P1 in the real flow, so it happens here too; the tests
  // that are about the sender gate itself skip this helper.
  await passWorldIdCheck(prisma, payerId, paymentId);
  return paymentId;
}

/** Signs an acceptance for a payment, optionally with the wrong key. */
async function signConsent(paymentId: string, signer = PAYEE, overrides: Record<string, string> = {}) {
  const prompt = (
    await app.inject({
      method: "GET",
      url: `/payments/${paymentId}/consent-prompt`,
      headers: auth(),
    })
  ).json();

  return signer.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: PAYEE_CONSENT_TYPES,
    primaryType: "PayeeConsent",
    message: buildPayeeConsentMessage({
      paymentRequestId: paymentId,
      payeeAddress: prompt.payeeAddress,
      amount: prompt.amount,
      token: prompt.token,
      invoiceRef: prompt.invoiceRef,
      ...overrides,
    }),
  });
}

describe.skipIf(!hasRealFixtures)("payee consent (P3-P4)", () => {
  it("asks the payee and moves the payment to AWAITING_PAYEE_CONSENT", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("AWAITING_PAYEE_CONSENT");

    const notification = await prisma.notification.findFirstOrThrow({
      where: { paymentRequestId: paymentId, kind: "CONSENT_REQUESTED" },
    });
    expect(notification.vendorId).toBe(vendorId);

    // The stored payload carries identifiers, never the payer's name. The name
    // is resolved at read time, so a leak of this table leaks nothing (D27).
    const payload = notification.payload as Record<string, unknown>;
    expect(payload.payerVendorId).toBe(payerId);
    expect(JSON.stringify(payload)).not.toContain(fixtureOracle().legalName);
  });

  it("refuses to notify the payee until the SENDER has passed World ID (P2)", async () => {
    // The sender's check is unconditional, unlike the payee's. Raising a
    // payment is what spends the payee's attention and pulls their record into
    // a comparison, so the party doing it has to be a live human every time —
    // otherwise the consent gate can be driven by a script.
    const { vendorId, walletId } = await onboardedPayee();
    const created = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId,
        vendorWalletId: walletId,
        payerVendorId: payerId,
        intendedPayeeName: fixtureOracle().legalName,
        intendedPayeePan: fixtureOracle().pan,
        invoiceRef: `INV-NOP2-${Date.now()}`,
        amount: "10.00",
        token: "USDC",
        network: "ethereum",
      },
    });
    const paymentId = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/sender must pass a World ID check/i);

    // Nothing reached the payee: a request that failed the sender gate must
    // not cost them a notification.
    expect(await prisma.notification.count({ where: { paymentRequestId: paymentId } })).toBe(0);

    // And once the sender does verify for THIS payment, it goes through.
    await passWorldIdCheck(prisma, payerId, paymentId);
    const retried = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    expect(retried.statusCode).toBe(200);
  });

  it("shows the payee who is asking, and for how much", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId, "999.00");
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    const prompt = await app.inject({
      method: "GET",
      url: `/payments/${paymentId}/consent-prompt`,
      headers: auth(),
    });

    expect(prompt.statusCode).toBe(200);
    expect(prompt.json()).toMatchObject({
      payerVendorId: payerId,
      amount: "999",
      token: "USDC",
      payeeAddress: PAYEE.address,
    });
  });

  it("refuses to run the identity match before the payee has accepted", async () => {
    // The central control. If this ever passes, the match is a free oracle:
    // anyone could ask whether an arbitrary address belongs to an arbitrary PAN.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/run-decision`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/has not accepted/i);
  });

  it("accepts a consent signed by the payout address and lets the decision run", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    const worldIdVerificationId = await passWorldIdCheck(prisma, vendorId, paymentId);

    const { accepted } = await acceptPayment(app, paymentId, PAYEE, auth, {
      worldIdVerificationId,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ decision: "ACCEPTED", status: "DECISION_PENDING" });

    const decision = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/run-decision`,
      headers: auth(),
    });
    expect(decision.statusCode).toBe(200);
  });

  it("records the acceptance in the evidence chain", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    const worldIdVerificationId = await passWorldIdCheck(prisma, vendorId, paymentId);
    await acceptPayment(app, paymentId, PAYEE, auth, { worldIdVerificationId });

    const record = await prisma.evidenceRecord.findFirstOrThrow({
      where: { paymentRequestId: paymentId, eventType: "payee_consent" },
    });
    const consentRow = await prisma.payeeConsent.findUniqueOrThrow({
      where: { paymentRequestId: paymentId },
    });
    const data = (record.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ decision: "ACCEPTED", signaturePresent: true });
    expect(data.signerAddress).toBe(PAYEE.address);

    // The signature itself stays out of the chain — it lives on the consent
    // row. The record says THAT one exists and which address produced it,
    // which is what a dispute needs; the 65 bytes add nothing and would be one
    // more copy of a credential-shaped value in an anchored, shared structure.
    expect(data).not.toHaveProperty("signature");
    expect(JSON.stringify(record.payload)).not.toContain(consentRow.signature!);
  });

  it("records both World ID checks in the chain, without the nullifier", async () => {
    // The nullifier is a stable per-person identifier within an action.
    // Writing it into an anchored, shareable structure would let anyone
    // holding two records link the same human across payments — the exact
    // correlation World ID's design avoids.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    const worldIdVerificationId = await passWorldIdCheck(prisma, vendorId, paymentId);
    await acceptPayment(app, paymentId, PAYEE, auth, { worldIdVerificationId });

    const records = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: paymentId },
      orderBy: { createdAt: "asc" },
    });
    const kinds = records.map((r) => r.eventType);
    expect(kinds).toEqual(["world_id_check", "world_id_check", "payee_consent"]);

    const parties = records
      .filter((r) => r.eventType === "world_id_check")
      .map((r) => (r.payload as { data: { party: string } }).data.party);
    expect(parties).toEqual(["sender", "payee"]);

    for (const record of records) {
      const data = (record.payload as { data: Record<string, unknown> }).data;
      expect(data).not.toHaveProperty("nullifier");
    }

    // The claim the field makes has to be true, not inherited from another
    // module's promise.
    const senderRecord = records[0]!;
    expect(
      (senderRecord.payload as { data: { nullifierMatchedEnrolment: boolean } }).data
        .nullifierMatchedEnrolment,
    ).toBe(true);
  });

  it("refuses a consent signed by a key that is not the payout address", async () => {
    // A stolen-invoice attacker can always sign SOMETHING. What they cannot do
    // is sign as the address the money is going to.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, STRANGER),
        signerAddress: STRANGER.address,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a well-formed signature that does not recover to the claimed address", async () => {
    // The address is an INPUT to verification, never a fact. Claiming to be the
    // payee while signing with another key must fail on the recovery, not on a
    // string comparison that could be satisfied by lying twice.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, STRANGER),
        signerAddress: PAYEE.address,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/does not recover/i);
  });

  it("refuses a consent signed for a different amount", async () => {
    // Consent is to a specific payment. If the amount were outside the signed
    // payload, one acceptance would wave through any sum afterwards.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId, "100.00");
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, PAYEE, { amount: "100000" }),
        signerAddress: PAYEE.address,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a consent signed for a different payment", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const first = await draftPayment(vendorId, walletId);
    const second = await draftPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${first}/request-consent`,
      headers: auth(),
    });
    await app.inject({
      method: "POST",
      url: `/payments/${second}/request-consent`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${second}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(first, PAYEE),
        signerAddress: PAYEE.address,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("stops a denied payment dead and never runs the match", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);

    const denied = await denyPayment(app, paymentId, auth);
    expect(denied.statusCode).toBe(200);
    expect(denied.json().decision).toBe("DENIED");

    // Not back to DRAFT: a refusal the sender could re-run is an invitation.
    const decision = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/run-decision`,
      headers: auth(),
    });
    expect(decision.statusCode).toBe(409);

    const matched = await prisma.evidenceRecord.count({
      where: { paymentRequestId: paymentId, eventType: "vendor_match" },
    });
    expect(matched).toBe(0);
  });

  it("refuses a second consent decision on the same payment", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    const worldIdVerificationId = await passWorldIdCheck(prisma, vendorId, paymentId);
    await acceptPayment(app, paymentId, PAYEE, auth, { worldIdVerificationId });

    const again = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "DENIED",
      },
    });
    expect(again.statusCode).toBe(409);
  });

  it("rejects a denial that carries a signature", async () => {
    // Not pedantry: accepting a signed denial would mean the two decisions have
    // different proof requirements only by convention, and a client could sign
    // one thing while sending another.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "DENIED",
        signature: await signConsent(paymentId, PAYEE),
        signerAddress: PAYEE.address,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe.skipIf(!hasRealFixtures)("the payee challenge (P5)", () => {
  it("demands a World ID check when the risk engine says so", async () => {
    // A first payment between two parties always triggers, so this is also the
    // default path a demo takes.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);

    const requested = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    expect(requested.json().challengeRequired).toBe(true);
    expect(requested.json().challengeTriggers).toContain("FIRST_PAYMENT_FROM_SENDER");

    const withoutCheck = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, PAYEE),
        signerAddress: PAYEE.address,
      },
    });
    expect(withoutCheck.statusCode).toBe(422);
    expect(withoutCheck.json().error.message).toMatch(/World ID/i);
  });

  it("refuses a World ID check taken for a different payment", async () => {
    // The signal binding is what stops one selfie from unlocking every payment
    // the payee is ever sent.
    const { vendorId, walletId } = await onboardedPayee();
    const other = await draftPayment(vendorId, walletId);
    const paymentId = await draftPayment(vendorId, walletId);
    const foreignCheck = await passWorldIdCheck(prisma, vendorId, other);

    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, PAYEE),
        signerAddress: PAYEE.address,
        worldIdVerificationId: foreignCheck,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/different payment/i);
  });

  it("refuses an enrolment standing in for a payment-time check", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    // Bound to THIS payment, so the signal check passes and the purpose check
    // is the only thing left that can refuse it.
    const enrolment = await enrolSubject(prisma, vendorId, paymentId);

    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, PAYEE),
        signerAddress: PAYEE.address,
        worldIdVerificationId: enrolment,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/enrolment/i);
  });

  it("refuses the sender's own check standing in for the payee's", async () => {
    // The sender already passed a World ID check for this payment at P2, with
    // the right signal and the right purpose. Everything about it matches
    // except WHOSE it is — which is the entire claim the payee's challenge
    // makes, so the subject check is the only thing that can catch it.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    const someoneElse = (
      await prisma.worldIdVerification.findFirstOrThrow({
        where: { subject: payerId, signal: paymentId, purpose: "REVERIFICATION" },
        select: { id: true },
      })
    ).id;

    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/consent`,
      payload: {
        decision: "ACCEPTED",
        signature: await signConsent(paymentId, PAYEE),
        signerAddress: PAYEE.address,
        worldIdVerificationId: someoneElse,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/different party/i);
  });
});

describe.skipIf(!hasRealFixtures)("identity blocks", () => {
  it("stops a blocked payer before the payee is even notified", async () => {
    // A block that still delivered the prompt would be a mute button. The
    // notification IS the cost the prober pays, so it must not be incurred.
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);

    const blocked = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/blocks`,
      headers: auth(),
      payload: { blockedVendorId: payerId, reason: "repeated wrong claims" },
    });
    expect(blocked.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(403);

    const notifications = await prisma.notification.count({
      where: { paymentRequestId: paymentId },
    });
    expect(notifications).toBe(0);

    const unblocked = await app.inject({
      method: "DELETE",
      url: `/vendors/${vendorId}/blocks/${payerId}`,
      headers: auth(),
    });
    expect(unblocked.json().removed).toBe(1);

    const retried = await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });
    expect(retried.statusCode).toBe(200);
  });

  it("is idempotent — blocking twice is not an error", async () => {
    const { vendorId } = await onboardedPayee();
    const first = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/blocks`,
      headers: auth(),
      payload: { blockedVendorId: payerId },
    });
    const second = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/blocks`,
      headers: auth(),
      payload: { blockedVendorId: payerId, reason: "still no" },
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
  });
});

describe.skipIf(!hasRealFixtures)("the mismatch alert (P6)", () => {
  it("tells the payee when someone claimed their identity and got it wrong", async () => {
    // Probing has to be visible. A silent no-match is the attacker's ideal
    // outcome: they learn a bit and the victim learns nothing.
    const { vendorId, walletId } = await onboardedPayee();
    const wrongClaim = await app.inject({
      method: "POST",
      url: "/payments",
      headers: auth(),
      payload: {
        vendorId,
        vendorWalletId: walletId,
        payerVendorId: payerId,
        intendedPayeeName: "Completely Different Holdings",
        intendedPayeePan: "ZZZZZ9999Z",
        invoiceRef: `INV-PROBE-${Date.now()}`,
        amount: "500.00",
        token: "USDC",
        network: "ethereum",
      },
    });
    const paymentId = wrongClaim.json().id as string;
    await passWorldIdCheck(prisma, payerId, paymentId);
    const worldIdVerificationId = await passWorldIdCheck(prisma, vendorId, paymentId);
    await acceptPayment(app, paymentId, PAYEE, auth, { worldIdVerificationId });

    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/run-decision`,
      headers: auth(),
    });

    const alert = await prisma.notification.findFirstOrThrow({
      where: { paymentRequestId: paymentId, kind: "IDENTITY_MISMATCH" },
    });
    expect(alert.vendorId).toBe(vendorId);

    // Names who asked, never what they claimed: echoing the attempted PAN back
    // would hand the payee a copy of whatever a prober typed.
    const payload = alert.payload as Record<string, unknown>;
    expect(payload.payerVendorId).toBe(payerId);
    expect(JSON.stringify(payload)).not.toContain("ZZZZZ9999Z");
    expect(JSON.stringify(payload)).not.toContain("Completely Different");
  });

  it("lists a payee's notifications, newest first", async () => {
    const { vendorId, walletId } = await onboardedPayee();
    const paymentId = await draftPayment(vendorId, walletId);
    await app.inject({
      method: "POST",
      url: `/payments/${paymentId}/request-consent`,
      headers: auth(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/vendors/${vendorId}/notifications?unreadOnly=true`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json() as { kind: string; readAt: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.kind).toBe("CONSENT_REQUESTED");
    expect(rows.every((row) => row.readAt === null)).toBe(true);
  });
});
