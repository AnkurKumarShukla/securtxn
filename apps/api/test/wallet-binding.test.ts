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

// Anvil account #1 — a deterministic dev key whose private key is public.
// Fine for tests and demos, never for real funds.
const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
// A different key: the "attacker signs with their own wallet" case.
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
    // The suite makes far more requests per minute from one address than a
    // real client would. Raised here rather than in the server, so production
    // rate limiting stays exactly as shipped.
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "wallet-binding-test");
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

  // Confirming a wallet issues a credential whenever ATS_ISSUER_PRIVATE_KEY is
  // set (D40), and VerifiableCredential.walletId is onDelete: Restrict — so
  // this has to go first or the wallet delete fails on the FK.
  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (blobs.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobs } } });

  await app?.close();
  await prisma.$disconnect();
});

async function createVendor(): Promise<{ id: string; nonce: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/vendors",
    headers: auth(),
    payload: {
      payeeType: "INDIVIDUAL",
      legalFirstName: fixtureOracle().legalFirstName,
      legalLastName: fixtureOracle().legalLastName,
      country: "IN",
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  vendorIds.push(body.id);
  return { id: body.id, nonce: body.onboardingSessionNonce };
}

/**
 * Runs the identity flow so the vendor is verified and has document hashes.
 *
 * The recorded fixture contains exactly ONE identity, and the service enforces
 * one DigiLocker account per vendor (D03). Releasing it from any previous
 * holder lets several vendors be exercised here; that uniqueness rule has its
 * own test in identity-flow.test.ts.
 */
async function verifyIdentity(vendorId: string): Promise<void> {
  await prisma.vendor.updateMany({
    where: { digilockerUserId: { not: null }, id: { not: vendorId } },
    data: { digilockerUserId: null },
  });

  const started = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/session`,
    headers: auth(),
    payload: { docTypes: ["aadhaar", "pan"] },
  });
  const { sessionId } = started.json();
  await app.inject({ method: "GET", url: `/dev/identity/consent?session_id=${sessionId}` });
  const done = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/complete`,
    headers: auth(),
  });
  expect(done.statusCode).toBe(200);
}

async function registerWallet(vendorId: string, address: string) {
  const res = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets`,
    headers: auth(),
    payload: { address, network: "ethereum" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { walletId: string; controlProofNonce: string; version: number };
}

/**
 * A vendor taken all the way to a signed identity binding.
 *
 * Module scope rather than inside one describe: both the binding tests and
 * the credential tests need it, and duplicating the setup is how two suites
 * quietly drift apart.
 */
async function fullyBoundVendor() {
  const vendor = await createVendor();
  await verifyIdentity(vendor.id);
  const wallet = await registerWallet(vendor.id, PAYEE.address);

  const controlSig = await PAYEE.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: WALLET_CONTROL_TYPES,
    primaryType: "WalletControlProof",
    message: buildWalletControlMessage({
      vendorId: vendor.id,
      walletAddress: PAYEE.address,
      network: "ethereum",
      nonce: wallet.controlProofNonce,
    }),
  });
  await app.inject({
    method: "POST",
    url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/control-proof`,
    headers: auth(),
    payload: { signature: controlSig },
  });

  const row = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
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

  return { vendor, wallet, row, bindingSig };
}

describe("vendor creation issues the onboarding nonce (D03)", () => {
  it("returns a server-generated 32-byte nonce", async () => {
    const { nonce } = await createVendor();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("gives each vendor a distinct nonce", async () => {
    const a = await createVendor();
    const b = await createVendor();
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("wallet control proof", () => {
  it("accepts a signature that recovers to the claimed address", async () => {
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    // The wallet carries the VENDOR's nonce, not a fresh one (D03).
    expect(wallet.controlProofNonce).toBe(vendor.nonce);

    const signature = await PAYEE.signTypedData({
      domain: domainFor(CHAIN_ID),
      types: WALLET_CONTROL_TYPES,
      primaryType: "WalletControlProof",
      message: buildWalletControlMessage({
        vendorId: vendor.id,
        walletAddress: PAYEE.address,
        network: "ethereum",
        nonce: wallet.controlProofNonce,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/control-proof`,
      headers: auth(),
      payload: { signature },
    });

    expect(res.statusCode).toBe(200);
    // Custody proven, but the wallet is NOT confirmed by it alone.
    expect(res.json().status).toBe("PENDING_VERIFICATION");
  });

  it("rejects a signature from a different key", async () => {
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    const signature = await OTHER.signTypedData({
      domain: domainFor(CHAIN_ID),
      types: WALLET_CONTROL_TYPES,
      primaryType: "WalletControlProof",
      message: buildWalletControlMessage({
        vendorId: vendor.id,
        walletAddress: PAYEE.address,
        network: "ethereum",
        nonce: wallet.controlProofNonce,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/control-proof`,
      headers: auth(),
      payload: { signature },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a signature made under a different nonce", async () => {
    // Replay from another onboarding attempt.
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    const signature = await PAYEE.signTypedData({
      domain: domainFor(CHAIN_ID),
      types: WALLET_CONTROL_TYPES,
      primaryType: "WalletControlProof",
      message: buildWalletControlMessage({
        vendorId: vendor.id,
        walletAddress: PAYEE.address,
        network: "ethereum",
        nonce: `0x${"ab".repeat(32)}`,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/control-proof`,
      headers: auth(),
      payload: { signature },
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a signature bound to a different chain", async () => {
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    const signature = await PAYEE.signTypedData({
      domain: domainFor(CHAIN_ID + 1),
      types: WALLET_CONTROL_TYPES,
      primaryType: "WalletControlProof",
      message: buildWalletControlMessage({
        vendorId: vendor.id,
        walletAddress: PAYEE.address,
        network: "ethereum",
        nonce: wallet.controlProofNonce,
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/control-proof`,
      headers: auth(),
      payload: { signature },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe.skipIf(!hasRealFixtures)("identity binding and confirmation", () => {


  it("accepts an attestation over the nonce, identity and document hashes", async () => {
    const { vendor, wallet, bindingSig } = await fullyBoundVendor();

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: bindingSig },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(row.attestationSig).toBe(bindingSig);
    expect(row.attestedAt).toBeInstanceOf(Date);
  });

  it("rejects an attestation signed by a different key", async () => {
    // The core attack: a genuine, completed KYC session paired with the
    // attacker's OWN wallet. Every individual check passes; the binding is
    // what catches it (D03).
    const { vendor, wallet, row } = await fullyBoundVendor();

    const forged = await OTHER.signTypedData({
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

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: forged },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses to bind before identity verification has completed", async () => {
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: `0x${"11".repeat(65)}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/identity verification must complete/i);
  });

  // --- the callback control (D05) ---

  it("confirms only through the independently verified contact", async () => {
    const { vendor, wallet, bindingSig } = await fullyBoundVendor();
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: bindingSig },
    });

    // The DigiLocker-verified mobile, from the identity flow — not from
    // anything submitted alongside the wallet.
    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("CONFIRMED");
    expect(res.json().confirmedAt).toBeTruthy();
  });

  it("rejects a number the attacker supplied themselves", async () => {
    // THE ATTACK: real identity, attacker's own wallet, attacker's own phone.
    // If the operator dials what was submitted, the attacker confirms their own
    // fraud. The server must refuse (D05).
    const { vendor, wallet, bindingSig } = await fullyBoundVendor();
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: bindingSig },
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      payload: { confirmedBy: "operator-1", channelUsed: "+919000000001" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/does not match any independently verified/i);
    // And it must not say which number WOULD have worked.
    expect(res.json().error.message).not.toContain(fixtureOracle().verifiedMobile);

    const row = await prisma.vendorWallet.findUniqueOrThrow({ where: { id: wallet.walletId } });
    expect(row.status).toBe("PENDING_VERIFICATION");
  });

  it("tolerates formatting differences in the same number", async () => {
    // A registry writes the number punctuated and with a country code, an
    // operator types it plainly; both must normalise to the same contact.
    // Rejecting that blocks a legitimate confirmation.
    const { vendor, wallet, bindingSig } = await fullyBoundVendor();
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: bindingSig },
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      // The same verified number, punctuated — the point is that normalisation
      // strips separators before comparing. Derived from the oracle so the real
      // number is not written into committed source.
      payload: {
        confirmedBy: "operator-1",
        channelUsed: fixtureOracle().verifiedMobile.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2 $3"),
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses to confirm without the control proof", async () => {
    const vendor = await createVendor();
    await verifyIdentity(vendor.id);
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/control proof/i);
  });

  it("fails closed when no independent contact exists at all", async () => {
    // No identity flow, so no verified mobile and no registry contact.
    // "Nothing on file" must never mean "skip the check".
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);

    const controlSig = await PAYEE.signTypedData({
      domain: domainFor(CHAIN_ID),
      types: WALLET_CONTROL_TYPES,
      primaryType: "WalletControlProof",
      message: buildWalletControlMessage({
        vendorId: vendor.id,
        walletAddress: PAYEE.address,
        network: "ethereum",
        nonce: wallet.controlProofNonce,
      }),
    });
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/control-proof`,
      headers: auth(),
      payload: { signature: controlSig },
    });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("wallet versioning (D01)", () => {
  it("increments the version rather than replacing the row", async () => {
    const vendor = await createVendor();
    const first = await registerWallet(vendor.id, PAYEE.address);
    const second = await registerWallet(vendor.id, OTHER.address);

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);

    const list = await app.inject({
      method: "GET",
      url: `/vendors/${vendor.id}/wallets`,
      headers: auth(),
    });
    expect(list.json()).toHaveLength(2);
  });

  it("treats another vendor's wallet as not found", async () => {
    const a = await createVendor();
    const b = await createVendor();
    const wallet = await registerWallet(a.id, PAYEE.address);

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${b.id}/wallets/${wallet.walletId}/control-proof`,
      headers: auth(),
      payload: { signature: `0x${"11".repeat(65)}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe.skipIf(!hasRealFixtures)("credential minted at confirmation (D42)", () => {
  it("issues a credential the moment the wallet reaches CONFIRMED", async () => {
    const { vendor, wallet, bindingSig } = await fullyBoundVendor();
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: bindingSig },
    });
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      payload: { confirmedBy: "operator-1", channelUsed: "9793953201" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/credential`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const credential = res.json();
    expect(credential.subjectAddress.toLowerCase()).toBe(PAYEE.address.toLowerCase());
    expect(credential.usable).toBe(true);
    // Not granted yet — the on-chain call has not happened.
    expect(credential.grantedTxHash).toBeNull();

    // Every gate is recorded, so the grant is backed by real verification
    // rather than an allowlist entry.
    expect(credential.claims).toMatchObject({
      xmlSignatureVerified: true,
      crossDocConsistent: true,
      sameSubjectLinked: true,
      walletControlProven: true,
      identityBindingSigned: true,
      callbackConfirmed: true,
      verificationTier: "TIER3_ADDRESS",
    });
  });

  it("sets the on-chain validity window from the identity TTL", async () => {
    // Verification is time-bounded, so the grant expires by itself (D06).
    const credential = await prisma.verifiableCredential.findFirstOrThrow({
      where: { vendorId: { in: vendorIds } },
      orderBy: { issuedAt: "desc" },
    });
    const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: credential.vendorId } });
    expect(credential.expiresAt?.getTime()).toBe(vendor.aadhaarKycTtl?.getTime());
  });

  it("stores no PII in the persisted claims", async () => {
    const credential = await prisma.verifiableCredential.findFirstOrThrow({
      where: { vendorId: { in: vendorIds } },
      orderBy: { issuedAt: "desc" },
    });
    const serialised = JSON.stringify(credential.claims).toLowerCase();
    for (const forbidden of ["ankur", "shukla", "7632", "9793953201"]) {
      expect(serialised, `claims leaked '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it("404s for a wallet that was never confirmed", async () => {
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);
    const res = await app.inject({
      method: "GET",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/credential`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe.skipIf(!hasRealFixtures)("on-chain KYC grant (D40)", () => {
  /** A confirmed wallet with a credential, ready to grant. */
  async function grantable() {
    const { vendor, wallet, bindingSig } = await fullyBoundVendor();
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/identity-binding`,
      headers: auth(),
      payload: { signature: bindingSig },
    });
    await app.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/callback-confirm`,
      headers: auth(),
      payload: { confirmedBy: "operator-1", channelUsed: "9793953201" },
    });
    return { vendor, wallet };
  }

  const grant = (vendorId: string, walletId: string) =>
    app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/wallets/${walletId}/grant-kyc`,
      headers: auth(),
    });

  it("refuses to grant for a wallet that was never confirmed", async () => {
    // The on-chain grant asserts the platform verified this payee. A wallet
    // that never cleared the three gates has nothing to assert.
    const vendor = await createVendor();
    const wallet = await registerWallet(vendor.id, PAYEE.address);
    const res = await grant(vendor.id, wallet.walletId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/only a CONFIRMED wallet/i);
  });

  it("refuses when no security has been issued yet", async () => {
    // Built without ATS_SECURITY_ID rather than relying on the ambient
    // environment: once a real security was deployed, an env-dependent test
    // started reaching the live chain.
    const { ATS_SECURITY_ID: _omitted, ...withoutSecurity } = base;
    const app2 = await buildServer({
      ...withoutSecurity,
      NODE_ENV: "test",
      isProduction: false,
      RATE_LIMIT_MAX: 1_000_000,
      IDENTITY_PROVIDER: "mock",
      DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
      COMPLIANCE_GATEWAY: "mock",
    });
    await app2.ready();
    const token = await app2.signToken("agent", "no-security-test");

    const { vendor, wallet } = await grantable();
    const res = await app2.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/grant-kyc`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/ATS_SECURITY_ID/);
    await app2.close();
  });

  it("refuses to grant an expired credential", async () => {
    // Putting a stale assertion on chain with an already-passed validity window
    // is worse than not granting at all (D06).
    const { vendor, wallet } = await grantable();
    await prisma.verifiableCredential.update({
      where: { walletId: wallet.walletId },
      data: { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    });

    const withSecurity = await buildServer({
      ...base,
      NODE_ENV: "test",
      isProduction: false,
      RATE_LIMIT_MAX: 1_000_000,
      IDENTITY_PROVIDER: "mock",
      DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
      ATS_SECURITY_ID: "0.0.9213391",
      // Never the real chain from a test.
      COMPLIANCE_GATEWAY: "mock",
    });
    await withSecurity.ready();
    const token = await withSecurity.signToken("agent", "grant-test");

    const res = await withSecurity.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/grant-kyc`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/expired or revoked/i);
    await withSecurity.close();
  });

  it("refuses when the credential issuer is not the configured on-chain key", async () => {
    // The chain records `issuer` as an address. If it does not match the key
    // that signed the credential, a verifier cannot connect the two.
    const { vendor, wallet } = await grantable();
    await prisma.verifiableCredential.update({
      where: { walletId: wallet.walletId },
      data: { issuerAddress: "0x000000000000000000000000000000000000dEaD" },
    });

    const withSecurity = await buildServer({
      ...base,
      NODE_ENV: "test",
      isProduction: false,
      RATE_LIMIT_MAX: 1_000_000,
      IDENTITY_PROVIDER: "mock",
      DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
      ATS_SECURITY_ID: "0.0.9213391",
      // Never the real chain from a test.
      COMPLIANCE_GATEWAY: "mock",
    });
    await withSecurity.ready();
    const token = await withSecurity.signToken("agent", "grant-test");

    const res = await withSecurity.inject({
      method: "POST",
      url: `/vendors/${vendor.id}/wallets/${wallet.walletId}/grant-kyc`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/issuer does not match/i);
    await withSecurity.close();
  });
});
