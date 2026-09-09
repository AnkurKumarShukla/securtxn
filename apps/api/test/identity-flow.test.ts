import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { decrypt, decryptJson, encrypt, hmac, hmacMatches } from "../src/lib/crypto.js";
import { fixtureOracle } from "./fixtures/oracle.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const REAL_FIXTURES = join(REPO_ROOT, "fixtures", "digilocker");
const hasRealFixtures = existsSync(join(REAL_FIXTURES, "documents", "aadhaar.xml"));

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

let app: FastifyInstance;
let agentToken: string;
const createdVendorIds: string[] = [];

async function newVendor(): Promise<string> {
  const vendor = await prisma.vendor.create({
    data: { payeeType: "INDIVIDUAL", country: "IN", legalFirstName: "Test", legalLastName: "Payee" },
  });
  createdVendorIds.push(vendor.id);
  return vendor.id;
}

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
    // Point the mock at the real recorded capture (D11).
    DIGILOCKER_FIXTURE_DIR: REAL_FIXTURES,
  };
  app = await buildServer(config);
  await app.ready();
  agentToken = await app.signToken("agent", "identity-flow-test");
});

afterAll(async () => {
  const blobIds = (
    await prisma.vendor.findMany({
      where: { id: { in: createdVendorIds } },
      select: { photoEncryptedRef: true },
    })
  )
    .map((v) => v.photoEncryptedRef)
    .filter((id): id is string => id !== null);

  await prisma.verifiableCredential.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  if (blobIds.length) await prisma.encryptedBlob.deleteMany({ where: { id: { in: blobIds } } });

  await app?.close();
  await prisma.$disconnect();
});

const auth = { authorization: () => `Bearer ${agentToken}` };

describe("crypto primitives", () => {
  const key = "a".repeat(64);

  it("round-trips a payload through AES-256-GCM", () => {
    const sealed = encryptFixture("the UIDAI portrait bytes", key);
    expect(decrypt(sealed, key).toString("utf8")).toBe("the UIDAI portrait bytes");
  });

  it("produces different ciphertext for identical plaintext", () => {
    // A fresh IV per call. Deterministic ciphertext would leak which vendors
    // share an address or a date of birth.
    const a = encryptFixture("same", key);
    const b = encryptFixture("same", key);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("refuses to decrypt tampered ciphertext", () => {
    const sealed = encryptFixture("sensitive", key);
    sealed.ciphertext[0] ^= 0xff;
    // GCM is authenticated: this throws rather than returning plausible garbage.
    expect(() => decrypt(sealed, key)).toThrow();
  });

  it("refuses a wrong key", () => {
    const sealed = encryptFixture("sensitive", key);
    expect(() => decrypt(sealed, "b".repeat(64))).toThrow();
  });

  it("hashes a PAN deterministically but not reversibly", () => {
    const pepper = "pepper-value-for-tests";
    // Case and whitespace are normalised, so the same PAN always matches.
    expect(hmac("abcde1234f", pepper)).toBe(hmac("  ABCDE1234F ", pepper));
    // A different pepper yields a different digest — rotation invalidates all.
    expect(hmac("ABCDE1234F", pepper)).not.toBe(hmac("ABCDE1234F", "other"));
    expect(hmacMatches(hmac("ABCDE1234F", pepper), hmac("ABCDE1234F", pepper))).toBe(true);
  });
});

describe("identity routes require the agent role", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/vendors/${randomUUID()}/identity/session`,
      payload: { docTypes: ["aadhaar"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an approver token on an agent route", async () => {
    const approver = await app.signToken("approver", "wrong-role");
    const res = await app.inject({
      method: "POST",
      url: `/vendors/${randomUUID()}/identity/session`,
      headers: { authorization: `Bearer ${approver}` },
      payload: { docTypes: ["aadhaar"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s for a vendor that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/vendors/${randomUUID()}/identity/session`,
      headers: { authorization: auth.authorization() },
      payload: { docTypes: ["aadhaar", "pan"] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe.skipIf(!hasRealFixtures)("identity flow end to end", () => {
  it("walks session → consent → complete and persists a verified identity", async () => {
    const vendorId = await newVendor();

    // 1. start
    const started = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/identity/session`,
      headers: { authorization: auth.authorization() },
      payload: { mobile: "9999999999", docTypes: ["aadhaar", "pan"] },
    });
    expect(started.statusCode).toBe(200);
    const { sessionId, authorizationUrl, onboardingSessionNonce } = started.json();
    expect(authorizationUrl).toContain("/dev/identity/consent");
    // The nonce that every later artifact must carry (D03).
    expect(onboardingSessionNonce).toMatch(/^0x[0-9a-f]{64}$/);

    // 2. status before consent — must NOT be succeeded (D17)
    const pending = await app.inject({
      method: "GET",
      url: `/vendors/${vendorId}/identity/status`,
      headers: { authorization: auth.authorization() },
    });
    expect(pending.json()).toMatchObject({ status: "created", consented: [] });

    // 3. completing before consent is refused
    const early = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/identity/complete`,
      headers: { authorization: auth.authorization() },
    });
    expect(early.statusCode).toBe(422);

    // 4. the human step, mocked
    const consent = await app.inject({
      method: "GET",
      url: `/dev/identity/consent?session_id=${sessionId}`,
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.headers["content-type"]).toContain("text/html");

    // 5. status after consent
    const ready = await app.inject({
      method: "GET",
      url: `/vendors/${vendorId}/identity/status`,
      headers: { authorization: auth.authorization() },
    });
    expect(ready.json()).toMatchObject({ status: "succeeded", consented: ["aadhaar", "pan"] });

    // 6. complete
    const completed = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/identity/complete`,
      headers: { authorization: auth.authorization() },
    });
    expect(completed.statusCode).toBe(200);

    const body = completed.json();
    expect(body.providerUserId).toBe(fixtureOracle().digilockerUserId);
    expect(body.checks).toEqual({
      xmlSignatureVerified: true,
      crossDocConsistent: true,
      sameSubjectLinked: true,
      ttlCaptured: true,
    });
    expect(body.aadhaarLast4).toBe(fixtureOracle().aadhaarLast4);
    expect(body.addressVerifiedMethod).toBe("ID_DOCUMENT");
    expect(body.resultingTier).toBe("TIER3_ADDRESS");
  });

  it("stores PII encrypted and the PAN only as a digest", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({
      where: { id: { in: createdVendorIds }, digilockerUserId: { not: null } },
    });

    // Nothing readable in the row itself.
    expect(vendor.panNumberHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(vendor.dobEncrypted).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\./);
    expect(vendor.aadhaarLast4).toBe(fixtureOracle().aadhaarLast4);

    // The address decrypts back to the attested Poa, including the fields the
    // real document abbreviates (lm / loc / pc).
    const address = decryptJson<Record<string, string>>(
      parseSealed(String(vendor.verifiedAddressEncrypted)),
      base.PII_ENCRYPTION_KEY,
    );
    expect(address.state).toBeTruthy();
    expect(address.pincode).toMatch(/^\d{6}$/);

    // The portrait is in the blob store, not in the vendor row.
    expect(vendor.photoEncryptedRef).toBeTruthy();
    const blob = await prisma.encryptedBlob.findUniqueOrThrow({
      where: { id: vendor.photoEncryptedRef! },
    });
    expect(blob.kind).toBe("IDENTITY_PHOTO");
    expect(blob.byteLength).toBeGreaterThan(1000);

    const photo = decrypt(
      {
        ciphertext: Buffer.from(blob.ciphertext),
        iv: Buffer.from(blob.iv),
        authTag: Buffer.from(blob.authTag),
      },
      base.PII_ENCRYPTION_KEY,
    );
    // A real JPEG: FF D8 FF.
    expect(photo.subarray(0, 3).toString("hex")).toBe("ffd8ff");
  });

  it("refuses to attach one DigiLocker identity to a second vendor", async () => {
    // Either a duplicate registration or an attempt to reuse someone else's
    // completed KYC (D03).
    const vendorId = await newVendor();

    const started = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/identity/session`,
      headers: { authorization: auth.authorization() },
      payload: { docTypes: ["aadhaar", "pan"] },
    });
    const { sessionId } = started.json();
    await app.inject({ method: "GET", url: `/dev/identity/consent?session_id=${sessionId}` });

    const res = await app.inject({
      method: "POST",
      url: `/vendors/${vendorId}/identity/complete`,
      headers: { authorization: auth.authorization() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("blocks the blob from being deleted while a vendor cites it", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({
      where: { id: { in: createdVendorIds }, photoEncryptedRef: { not: null } },
    });
    await expect(
      prisma.encryptedBlob.delete({ where: { id: vendor.photoEncryptedRef! } }),
    ).rejects.toThrow();
  });
});

describe("consent stub is mock-only", () => {
  it("is described in the OpenAPI document under dev", async () => {
    const doc = (await app.inject({ method: "GET", url: "/swagger/json" })).json();
    expect(Object.keys(doc.paths)).toContain("/dev/identity/consent");
    expect(Object.keys(doc.paths)).toContain("/vendors/{id}/identity/complete");
  });
});

// --- helpers ---------------------------------------------------------------

function encryptFixture(value: string, key: string) {
  return encrypt(value, key);
}

function parseSealed(serialised: string) {
  const [iv = "", authTag = "", ciphertext = ""] = serialised.split(".");
  return {
    iv: Buffer.from(iv, "base64"),
    authTag: Buffer.from(authTag, "base64"),
    ciphertext: Buffer.from(ciphertext, "base64"),
  };
}
