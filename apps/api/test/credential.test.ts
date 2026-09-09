import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  VC_DOMAIN_NAME,
  VC_DOMAIN_VERSION,
  VC_TYPES,
  hashClaims,
  isUsable,
  issueCredential,
  toUnixSeconds,
  type CredentialClaims,
} from "../src/lib/vc.js";

const ISSUER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ISSUER = privateKeyToAccount(ISSUER_KEY);
const SUBJECT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CHAIN_ID = 296; // Hedera testnet

function claims(overrides: Partial<CredentialClaims> = {}): CredentialClaims {
  return {
    providerUserId: "8ae4e10fc82d9e0d3852c60fc0a15c51",
    verificationTier: "TIER3_ADDRESS",
    xmlSignatureVerified: true,
    crossDocConsistent: true,
    sameSubjectLinked: true,
    walletControlProven: true,
    identityBindingSigned: true,
    callbackConfirmed: true,
    addressVerifiedMethod: "ID_DOCUMENT",
    country: "IN",
    onboardingSessionNonce: `0x${"11".repeat(32)}`,
    ...overrides,
  };
}

const issue = (over: Partial<Parameters<typeof issueCredential>[0]> = {}) =>
  issueCredential({
    credentialId: "00000000-0000-4000-8000-0000000000c1",
    subjectAddress: SUBJECT,
    claims: claims(),
    issuedAt: new Date("2026-09-09T10:00:00.000Z"),
    expiresAt: new Date("2027-09-03T04:10:04.000Z"),
    chainId: CHAIN_ID,
    issuerPrivateKey: ISSUER_KEY,
    ...over,
  });

describe("credential issuance", () => {
  it("signs so the recovered signer matches the on-chain issuer argument", async () => {
    // ATS records `issuer` as an address. A verifier recovers the signer and
    // compares it directly — no key-resolution step in between (D42).
    const credential = await issue();
    expect(credential.issuerAddress).toBe(ISSUER.address);

    const valid = await verifyTypedData({
      address: credential.issuerAddress,
      domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: CHAIN_ID },
      types: VC_TYPES,
      primaryType: "PayeeVerification",
      message: {
        credentialId: credential.credentialId,
        subjectAddress: credential.subjectAddress,
        providerUserId: credential.claims.providerUserId,
        verificationTier: credential.claims.verificationTier,
        claimsHash: hashClaims(credential.claims),
        issuedAt: BigInt(toUnixSeconds(credential.issuedAt)),
        expiresAt: BigInt(toUnixSeconds(credential.expiresAt!)),
      },
      signature: credential.signature,
    });
    expect(valid).toBe(true);
  });

  it("does not verify once a single claim is altered", async () => {
    // The signature covers a hash of the whole claim set, so tampering with any
    // one of them invalidates it.
    const credential = await issue();
    const tampered = { ...credential.claims, callbackConfirmed: false };

    const valid = await verifyTypedData({
      address: credential.issuerAddress,
      domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: CHAIN_ID },
      types: VC_TYPES,
      primaryType: "PayeeVerification",
      message: {
        credentialId: credential.credentialId,
        subjectAddress: credential.subjectAddress,
        providerUserId: tampered.providerUserId,
        verificationTier: tampered.verificationTier,
        claimsHash: hashClaims(tampered),
        issuedAt: BigInt(toUnixSeconds(credential.issuedAt)),
        expiresAt: BigInt(toUnixSeconds(credential.expiresAt!)),
      },
      signature: credential.signature,
    });
    expect(valid).toBe(false);
  });

  it("binds to a chain, so a credential cannot be replayed onto another", async () => {
    const credential = await issue();
    const valid = await verifyTypedData({
      address: credential.issuerAddress,
      // Mainnet instead of testnet.
      domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: 295 },
      types: VC_TYPES,
      primaryType: "PayeeVerification",
      message: {
        credentialId: credential.credentialId,
        subjectAddress: credential.subjectAddress,
        providerUserId: credential.claims.providerUserId,
        verificationTier: credential.claims.verificationTier,
        claimsHash: hashClaims(credential.claims),
        issuedAt: BigInt(toUnixSeconds(credential.issuedAt)),
        expiresAt: BigInt(toUnixSeconds(credential.expiresAt!)),
      },
      signature: credential.signature,
    });
    expect(valid).toBe(false);
  });

  it("hashes claims independently of key order", async () => {
    const forward = claims();
    const reordered = Object.fromEntries(
      Object.entries(forward).reverse(),
    ) as unknown as CredentialClaims;
    expect(hashClaims(reordered)).toBe(hashClaims(forward));
  });

  it("treats a missing expiry as zero, matching the on-chain validTo", async () => {
    // ATS reads validTo as a uint256; zero is how "no expiry" is expressed.
    const credential = await issue({ expiresAt: null });
    expect(credential.expiresAt).toBeNull();
    const valid = await verifyTypedData({
      address: credential.issuerAddress,
      domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: CHAIN_ID },
      types: VC_TYPES,
      primaryType: "PayeeVerification",
      message: {
        credentialId: credential.credentialId,
        subjectAddress: credential.subjectAddress,
        providerUserId: credential.claims.providerUserId,
        verificationTier: credential.claims.verificationTier,
        claimsHash: hashClaims(credential.claims),
        issuedAt: BigInt(toUnixSeconds(credential.issuedAt)),
        expiresAt: 0n,
      },
      signature: credential.signature,
    });
    expect(valid).toBe(true);
  });
});

describe("credentials carry no PII (design principle 2)", () => {
  it("contains nothing identifying, even for a fully verified payee", async () => {
    // A credential is referenced from a public chain and may be disclosed in
    // full. Every value here must survive that.
    const credential = await issue();
    const serialised = JSON.stringify(credential).toLowerCase();

    for (const forbidden of [
      "ankur", // legal name
      "shukla",
      "7632", // Aadhaar last four
      "9793953201", // verified mobile
      "19-11-2001", // date of birth
      "meridian", // entity name
      "lucknow", // address locality
    ]) {
      expect(serialised, `credential leaked '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it("asserts that checks passed, not what the documents said", async () => {
    const credential = await issue();
    const values = Object.values(credential.claims);
    // Every claim is a boolean, or a short opaque/enum string. Nothing free-form.
    for (const value of values) {
      expect(["boolean", "string"]).toContain(typeof value);
    }
    expect(credential.claims.xmlSignatureVerified).toBe(true);
    expect(credential.claims.callbackConfirmed).toBe(true);
  });
});

describe("usability gate", () => {
  const base = { expiresAt: new Date("2027-09-03T04:10:04.000Z"), revokedAt: null };

  it("is usable before expiry", () => {
    expect(isUsable(base, new Date("2026-09-09T00:00:00.000Z"))).toBe(true);
  });

  it("stops being usable at expiry, without anyone acting", () => {
    // Verification is time-bounded (D06), so the grant is too.
    expect(isUsable(base, new Date("2028-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("is not usable once revoked, even before expiry", () => {
    expect(
      isUsable({ ...base, revokedAt: new Date("2026-09-10T00:00:00.000Z") }, new Date("2026-09-11")),
    ).toBe(false);
  });

  it("is usable with no expiry set", () => {
    expect(isUsable({ expiresAt: null, revokedAt: null })).toBe(true);
  });
});
