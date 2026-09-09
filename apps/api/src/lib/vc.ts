// Verifiable credential issuance.
//
// This is what turns an on-chain KYC grant from an allowlist entry into a
// claim someone can check. ATS records only a reference —
// `grantKyc(account, vcId, validFrom, validTo, issuer)` — so the credential
// itself lives here, and the chain says "issuer X asserted credential Y about
// account Z, valid until T" (D42).
//
// WHAT THE CLAIMS MAY CONTAIN: assertions THAT checks passed, never the
// evidence behind them. No legal name, no address, no Aadhaar digits, no PAN.
// A credential is published by reference to a public chain and may be disclosed
// in full at any time, so it has to be safe to disclose in full (design
// principle 2, D27).
//
// Spec: docs/architecture.md §4.5, §4.7

import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { VerificationTier } from "@cp/shared-types";

export const VC_DOMAIN_NAME = "ConfirmedPayeeCredential";
export const VC_DOMAIN_VERSION = "1";

export const VC_TYPES = {
  PayeeVerification: [
    { name: "credentialId", type: "string" },
    { name: "subjectAddress", type: "address" },
    { name: "providerUserId", type: "string" },
    { name: "verificationTier", type: "string" },
    { name: "claimsHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

/**
 * The assertions carried by the credential.
 *
 * Every field is a boolean, an enum, or an opaque identifier. Read the list and
 * ask of any addition: could this identify or describe the person? If yes, it
 * belongs in the encrypted store, not here.
 */
export type CredentialClaims = {
  /** Stable pseudonymous DigiLocker id — an identifier, not an identity (D02). */
  providerUserId: string;
  verificationTier: VerificationTier;

  /** The four mandatory document checks (§4.7). */
  xmlSignatureVerified: boolean;
  crossDocConsistent: boolean;
  sameSubjectLinked: boolean;

  /** The wallet gates (D34). */
  walletControlProven: boolean;
  identityBindingSigned: boolean;
  callbackConfirmed: boolean;

  /** How the address was established, without disclosing it. */
  addressVerifiedMethod: string;
  /** ISO country only — jurisdiction is needed for compliance, and is not identifying. */
  country: string;

  /** Ties this credential to the onboarding attempt that produced it (D03). */
  onboardingSessionNonce: string;
};

export type IssuedCredential = {
  credentialId: string;
  subjectAddress: Address;
  claims: CredentialClaims;
  signature: Hex;
  issuerAddress: Address;
  issuedAt: Date;
  expiresAt: Date | null;
};

export type IssueInput = {
  credentialId: string;
  subjectAddress: string;
  claims: CredentialClaims;
  issuedAt: Date;
  /** From aadhaarKycTtl. Null means no expiry was established. */
  expiresAt: Date | null;
  chainId: number;
  issuerPrivateKey: string;
};

/**
 * Signs a credential with the platform issuer key.
 *
 * EIP-712 rather than a JWS because the on-chain `issuer` argument is an
 * Ethereum address — so a verifier recovers the signer and compares it to what
 * the chain records, with no key-resolution step in between.
 */
export async function issueCredential(input: IssueInput): Promise<IssuedCredential> {
  const account = privateKeyToAccount(input.issuerPrivateKey as Hex);

  const signature = await account.signTypedData({
    domain: { name: VC_DOMAIN_NAME, version: VC_DOMAIN_VERSION, chainId: input.chainId },
    types: VC_TYPES,
    primaryType: "PayeeVerification",
    message: {
      credentialId: input.credentialId,
      subjectAddress: input.subjectAddress as Address,
      providerUserId: input.claims.providerUserId,
      verificationTier: input.claims.verificationTier,
      claimsHash: hashClaims(input.claims),
      issuedAt: BigInt(toUnixSeconds(input.issuedAt)),
      // Zero means "no expiry", matching how the on-chain validTo is read.
      expiresAt: BigInt(input.expiresAt ? toUnixSeconds(input.expiresAt) : 0),
    },
  });

  return {
    credentialId: input.credentialId,
    subjectAddress: input.subjectAddress as Address,
    claims: input.claims,
    signature,
    issuerAddress: account.address,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

/** Unix seconds — the unit the on-chain validFrom/validTo use. */
export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Commitment over the full claim set.
 *
 * The signature covers this rather than each field, so adding a claim later
 * cannot silently produce a credential that verifies against an older shape.
 */
export function hashClaims(claims: CredentialClaims): Hex {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(claims).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
  return keccak256(toHex(canonical));
}

/**
 * A credential is usable only while every condition holds.
 *
 * Expiry is checked here rather than trusted from the chain: the on-chain
 * validity window is what the token enforces, and this is what the platform
 * enforces before it ever asks the chain to grant.
 */
export function isUsable(
  credential: { expiresAt: Date | null; revokedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (credential.revokedAt !== null) return false;
  if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}
