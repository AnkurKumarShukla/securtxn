// End-to-end coverage for the verifiable-credential path (D40/D42/D43) —
// previously wired into wallets/service.ts with zero test coverage and,
// without ATS_ISSUER_PRIVATE_KEY configured, never actually executed.
//
// Walks the REAL DigiLocker fixtures through the full onboarding chain
// (identity → wallet control proof → identity binding → callback confirm)
// to CONFIRMED, exactly as wallet-binding.test.ts does, then asserts on what
// that triggers: a VerifiableCredential row whose claims are PII-free, whose
// EIP-712 signature actually recovers to the configured issuer address, and
// whose expiry tracks the vendor's own aadhaarKycTtl — not just "a row exists".

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { recoverTypedDataAddress } from "viem";
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
import { VC_DOMAIN_NAME, VC_DOMAIN_VERSION, VC_TYPES, hashClaims, toUnixSeconds } from "../src/lib/vc.js";
import { fixtureOracle } from "./fixtures/oracle.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

// Same deterministic dev keys wallet-binding.test.ts uses — public, never for
// real funds, fine for tests.
const PAYEE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });
const WALLET_CHAIN_ID = base.HEDERA_CHAIN_ID;

// Two servers, two configs: one with the issuer key set (the path under
// test), one without (the "fails closed, does not block confirmation"
// guarantee the code comments promise but nothing previously checked).
let appWithIssuer: FastifyInstance;
let appNoIssuer: FastifyInstance;
let tokenWithIssuer: string;
let tokenNoIssuer: string;
const vendorIds: string[] = [];

// Anvil/Hardhat account #0 — a key published in their own documentation, so
// it is safe in a committed file in a way a generated key is not. This test
// injects the key into the server it builds rather than reading .env, so it
// needs A key, not THE key; the real dev issuer stays in .env and out of git.
const ISSUER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const issuerAccount = privateKeyToAccount(ISSUER_KEY);

function authFor(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const shared = {
    ...base,
    NODE_ENV: "test" as const,
    // Pinned, not inherited — see the note in payment-flow.test.ts (D09).
    VENDOR_MATCHER: "fallback" as const,
    // Pinned for the same reason as VENDOR_MATCHER: the deployed default now
    // talks to Hedera testnet, and a unit suite must not depend on a public
    // network being up. The on-chain branch is covered by decision.test.ts.
    COMPLIANCE_GATEWAY: "mock" as const,
    // Pinned with the other two: the deployed default now broadcasts to Hedera
    // testnet, and no unit test may spend real testnet funds or depend on a
    // public network being up.
    CHAIN_GATEWAY: "mock" as const,
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock" as const,
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
  };

  appWithIssuer = await buildServer({ ...shared, ATS_ISSUER_PRIVATE_KEY: ISSUER_KEY } as Config);
  await appWithIssuer.ready();
  tokenWithIssuer = await appWithIssuer.signToken("agent", "credential-issuance-test");

  appNoIssuer = await buildServer({ ...shared, ATS_ISSUER_PRIVATE_KEY: undefined } as Config);
  await appNoIssuer.ready();
  tokenNoIssuer = await appNoIssuer.signToken("agent", "credential-issuance-test-no-issuer");
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

  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  if (blobs.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobs } } });

  await appWithIssuer?.close();
  await appNoIssuer?.close();
  await prisma.$disconnect();
});

/**
 * Runs the full onboarding chain to CONFIRMED against the real recorded
 * DigiLocker fixtures — the actual data this suite exercises, standing in for
 * a live consent flow once one is wired. Returns the vendor id so tests can
 * inspect what confirming the wallet actually produced.
 */
async function confirmedVendor(app: FastifyInstance, token: string): Promise<{ vendorId: string; walletId: string }> {
  // The fixture backs exactly one DigiLocker identity; release it from any
  // previous holder so this can run more than once per file (same pattern as
  // wallet-binding.test.ts's verifyIdentity).
  await prisma.vendor.updateMany({
    where: { digilockerUserId: { not: null } },
    data: { digilockerUserId: null },
  });

  const created = await app.inject({
    method: "POST",
    url: "/vendors",
    headers: authFor(token),
    payload: {
      payeeType: "INDIVIDUAL",
      // From the ignored fixtures: the name must match the DigiLocker subject.
      legalFirstName: fixtureOracle().legalFirstName,
      legalLastName: fixtureOracle().legalLastName,
      country: "IN",
    },
  });
  expect(created.statusCode).toBe(201);
  const vendorId = created.json().id as string;
  vendorIds.push(vendorId);

  const started = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/session`,
    headers: authFor(token),
    payload: { docTypes: ["aadhaar", "pan"] },
  });
  const { sessionId } = started.json();
  await app.inject({ method: "GET", url: `/dev/identity/consent?session_id=${sessionId}` });
  const completed = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/identity/complete`,
    headers: authFor(token),
  });
  expect(completed.statusCode).toBe(200);

  const walletRes = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets`,
    headers: authFor(token),
    payload: { address: PAYEE.address, network: "ethereum" },
  });
  expect(walletRes.statusCode).toBe(201);
  const { walletId, controlProofNonce } = walletRes.json() as { walletId: string; controlProofNonce: string };

  const controlSig = await PAYEE.signTypedData({
    domain: domainFor(WALLET_CHAIN_ID),
    types: WALLET_CONTROL_TYPES,
    primaryType: "WalletControlProof",
    message: buildWalletControlMessage({
      vendorId,
      walletAddress: PAYEE.address,
      network: "ethereum",
      nonce: controlProofNonce,
    }),
  });
  const controlRes = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/control-proof`,
    headers: authFor(token),
    payload: { signature: controlSig },
  });
  expect(controlRes.statusCode).toBe(200);

  const row = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
  const bindingSig = await PAYEE.signTypedData({
    domain: domainFor(WALLET_CHAIN_ID),
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
  const bindingRes = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/identity-binding`,
    headers: authFor(token),
    payload: { signature: bindingSig },
  });
  expect(bindingRes.statusCode).toBe(200);

  // The DigiLocker-verified mobile from the real fixture — see
  // fixtures/digilocker/README.md.
  const confirmRes = await app.inject({
    method: "POST",
    url: `/vendors/${vendorId}/wallets/${walletId}/callback-confirm`,
    headers: authFor(token),
    payload: { confirmedBy: "operator-1", channelUsed: fixtureOracle().verifiedMobile },
  });
  expect(confirmRes.statusCode).toBe(200);
  expect(confirmRes.json().status).toBe("CONFIRMED");

  return { vendorId, walletId };
}

describe.skipIf(!hasRealFixtures)("verifiable credential issuance (D40, D42)", () => {
  it("issues a credential the moment the wallet reaches CONFIRMED", async () => {
    const { vendorId, walletId } = await confirmedVendor(appWithIssuer, tokenWithIssuer);

    const credential = await prisma.verifiableCredential.findUnique({ where: { walletId } });
    expect(credential).not.toBeNull();
    expect(credential!.vendorId).toBe(vendorId);
    expect(credential!.subjectAddress.toLowerCase()).toBe(PAYEE.address.toLowerCase());
    expect(credential!.issuerAddress.toLowerCase()).toBe(issuerAccount.address.toLowerCase());
    expect(credential!.revokedAt).toBeNull();
  });

  it("claims assert only that checks passed — no name, address, or document digits", async () => {
    const { walletId } = await confirmedVendor(appWithIssuer, tokenWithIssuer);
    const credential = await prisma.verifiableCredential.findUniqueOrThrow({ where: { walletId } });
    const claims = credential.claims as Record<string, unknown>;

    // Every value must be a boolean, an enum/string identifier, or a nonce —
    // never something that identifies or describes the person (design
    // principle 2). Assert the shape directly rather than trusting the type.
    expect(Object.keys(claims).sort()).toEqual(
      [
        "addressVerifiedMethod",
        "callbackConfirmed",
        "country",
        "crossDocConsistent",
        "identityBindingSigned",
        "onboardingSessionNonce",
        "providerUserId",
        "sameSubjectLinked",
        "verificationTier",
        "walletControlProven",
        "xmlSignatureVerified",
      ].sort(),
    );

    expect(claims.xmlSignatureVerified).toBe(true);
    expect(claims.crossDocConsistent).toBe(true);
    expect(claims.sameSubjectLinked).toBe(true);
    expect(claims.walletControlProven).toBe(true);
    expect(claims.identityBindingSigned).toBe(true);
    expect(claims.callbackConfirmed).toBe(true);
    expect(claims.country).toBe("IN");

    const serialised = JSON.stringify(claims);

    // No name, anywhere.
    expect(serialised).not.toMatch(
      new RegExp(`${fixtureOracle().legalFirstName}|${fixtureOracle().legalLastName}`, "i"),
    );

    // No PII from the fixture, checked by VALUE rather than by shape. An
    // earlier version of this test asserted /\d{4,}/ — "no run of 4+ digits"
    // — which fails against `providerUserId` and `onboardingSessionNonce`.
    // Those are hex identifiers that legitimately contain digits and are
    // explicitly not identities (D02); flagging them was a false positive
    // that would have made this test unfixable without weakening it.
    expect(serialised).not.toContain(fixtureOracle().verifiedMobile);
    expect(serialised).not.toContain(fixtureOracle().aadhaarLast4);
    expect(serialised).not.toMatch(new RegExp(`${fixtureOracle().panPrefix}|PAN`, "i"));
    expect(serialised).not.toMatch(new RegExp(fixtureOracle().addressTerms.join("|"), "i"));

    // And positively: every value is a boolean, an enum, or an opaque id —
    // never free text that could describe a person.
    for (const [key, value] of Object.entries(claims)) {
      const isSafe =
        typeof value === "boolean" ||
        (typeof value === "string" && /^[A-Za-z0-9_x-]+$/.test(value));
      expect(isSafe, `claim "${key}" is not a boolean, enum or opaque id`).toBe(true);
    }
  });

  it("the signature genuinely recovers to the configured issuer address", async () => {
    const { walletId } = await confirmedVendor(appWithIssuer, tokenWithIssuer);
    const credential = await prisma.verifiableCredential.findUniqueOrThrow({ where: { walletId } });
    const claims = credential.claims as Record<string, unknown>;

    const recovered = await recoverTypedDataAddress({
      domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: base.HEDERA_CHAIN_ID },
      types: VC_TYPES,
      primaryType: "PayeeVerification",
      message: {
        credentialId: credential.id,
        subjectAddress: credential.subjectAddress as `0x${string}`,
        providerUserId: claims.providerUserId as string,
        verificationTier: claims.verificationTier as string,
        claimsHash: hashClaims(claims as never),
        issuedAt: BigInt(toUnixSeconds(credential.issuedAt)),
        expiresAt: BigInt(credential.expiresAt ? toUnixSeconds(credential.expiresAt) : 0),
      },
      signature: credential.signature as `0x${string}`,
    });

    expect(recovered.toLowerCase()).toBe(issuerAccount.address.toLowerCase());
  });

  it("a tampered claim no longer recovers to the issuer — the signature actually covers the claims", async () => {
    const { walletId } = await confirmedVendor(appWithIssuer, tokenWithIssuer);
    const credential = await prisma.verifiableCredential.findUniqueOrThrow({ where: { walletId } });
    const claims = credential.claims as Record<string, unknown>;

    // Flip a single boolean the way a compromised record store might.
    const tampered = { ...claims, callbackConfirmed: false };

    const recovered = await recoverTypedDataAddress({
      domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: base.HEDERA_CHAIN_ID },
      types: VC_TYPES,
      primaryType: "PayeeVerification",
      message: {
        credentialId: credential.id,
        subjectAddress: credential.subjectAddress as `0x${string}`,
        providerUserId: claims.providerUserId as string,
        verificationTier: claims.verificationTier as string,
        claimsHash: hashClaims(tampered as never), // recompute over the tampered set
        issuedAt: BigInt(toUnixSeconds(credential.issuedAt)),
        expiresAt: BigInt(credential.expiresAt ? toUnixSeconds(credential.expiresAt) : 0),
      },
      signature: credential.signature as `0x${string}`,
    });

    expect(recovered.toLowerCase()).not.toBe(issuerAccount.address.toLowerCase());
  });

  it("expiry tracks the vendor's own aadhaarKycTtl, not a fixed TTL", async () => {
    const { vendorId, walletId } = await confirmedVendor(appWithIssuer, tokenWithIssuer);
    const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    const credential = await prisma.verifiableCredential.findUniqueOrThrow({ where: { walletId } });

    expect(vendor.aadhaarKycTtl).not.toBeNull();
    expect(credential.expiresAt?.getTime()).toBe(vendor.aadhaarKycTtl!.getTime());
  });

  it("never blocks confirmation when no issuer key is configured — fails closed, silently", async () => {
    const { walletId } = await confirmedVendor(appNoIssuer, tokenNoIssuer);

    const wallet = await prisma.vendorWallet.findUniqueOrThrow({ where: { id: walletId } });
    expect(wallet.status).toBe("CONFIRMED");

    const credential = await prisma.verifiableCredential.findUnique({ where: { walletId } });
    expect(credential).toBeNull();
  });
});
