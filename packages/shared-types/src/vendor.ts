// Vendor registry and wallet-versioning wire shapes.
// Spec: docs/architecture.md §4.1

import { z } from "zod";
import { KybStatus, PayeeType, VerificationTier, WalletStatus } from "./enums.js";
import { Bytes32, CountryCode, EvmAddress, Network, PhoneNumber, Signature, Uuid } from "./primitives.js";

/**
 * POST /vendors
 *
 * An individual payee needs a legal name; a business needs an entity name.
 * Neither is optional in practice, so the discriminator enforces it rather than
 * leaving both nullable and checking later.
 */
export const CreateVendorRequest = z.discriminatedUnion("payeeType", [
  z.object({
    payeeType: z.literal(PayeeType.enum.INDIVIDUAL),
    legalFirstName: z.string().min(1).max(100),
    legalLastName: z.string().min(1).max(100),
    country: CountryCode,
    verifiedEmail: z.string().email().optional(),
  }),
  z.object({
    payeeType: z.literal(PayeeType.enum.BUSINESS),
    legalEntityName: z.string().min(1).max(200),
    country: CountryCode,
    verifiedEmail: z.string().email().optional(),
    /**
     * Raw tax id. Stored only as an HMAC (D06) — it is accepted here and
     * discarded after hashing, never persisted in this form.
     */
    taxId: z.string().min(1).max(64).optional(),
  }),
]);
export type CreateVendorRequest = z.infer<typeof CreateVendorRequest>;

export const CreateVendorResponse = z.object({
  id: Uuid,
  payeeType: PayeeType,
  kybStatus: KybStatus,
  verificationTier: VerificationTier,
  /**
   * Must be carried unchanged into the liveness check, the document check and
   * the wallet-control signature. Differing nonces mean the artifacts may
   * belong to different people (D03).
   */
  onboardingSessionNonce: Bytes32,
});
export type CreateVendorResponse = z.infer<typeof CreateVendorResponse>;

/**
 * Safe projection of a vendor. Everything identifying is either absent or
 * reduced to a non-reversible form: no DOB, no address, no full Aadhaar, no
 * PAN, no raw tax id (D06). Widening this type is how PII leaks.
 */
export const VendorSummary = z.object({
  id: Uuid,
  payeeType: PayeeType,
  displayName: z.string(),
  country: CountryCode,
  kybStatus: KybStatus,
  verificationTier: VerificationTier,
  /** Last four digits only — the full number is never received (D02). */
  aadhaarLast4: z.string().length(4).nullable(),
  /** Both must be true before a wallet may be CONFIRMED (D04). */
  xmlSignatureVerified: z.boolean(),
  crossDocConsistent: z.boolean(),
  /** Verification expires; CONFIRMED is not permanent (D06). */
  aadhaarKycTtl: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type VendorSummary = z.infer<typeof VendorSummary>;

/** PATCH /vendors/:id/kyb-status — manual for MVP (§6). */
export const UpdateKybStatusRequest = z.object({
  kybStatus: KybStatus,
  note: z.string().max(500).optional(),
});
export type UpdateKybStatusRequest = z.infer<typeof UpdateKybStatusRequest>;

/** POST /vendors/:id/wallets */
export const RegisterWalletRequest = z.object({
  address: EvmAddress,
  network: Network,
  tokenContract: EvmAddress.optional(),
});
export type RegisterWalletRequest = z.infer<typeof RegisterWalletRequest>;

export const RegisterWalletResponse = z.object({
  walletId: Uuid,
  version: z.number().int().positive(),
  status: WalletStatus,
  /** The exact string the payee must sign to prove key custody. */
  challengeMessage: z.string(),
  controlProofNonce: Bytes32,
});
export type RegisterWalletResponse = z.infer<typeof RegisterWalletResponse>;

/**
 * POST /vendors/:id/wallets/:walletId/control-proof
 *
 * Proves key custody ONLY. It says nothing about who the signer is, and is
 * never sufficient for CONFIRMED on its own (D03).
 */
export const ControlProofRequest = z.object({
  signature: Signature,
});
export type ControlProofRequest = z.infer<typeof ControlProofRequest>;

/**
 * POST /vendors/:id/wallets/:walletId/callback-confirm
 *
 * `channelUsed` is the contact actually dialed. The server rejects the
 * confirmation unless it matches an independently sourced contact — never one
 * taken from the current submission, which is what stops an attacker
 * confirming their own number (D05).
 */
export const CallbackConfirmRequest = z.object({
  confirmedBy: z.string().min(1).max(100),
  channelUsed: PhoneNumber,
  notes: z.string().max(1000).optional(),
});
export type CallbackConfirmRequest = z.infer<typeof CallbackConfirmRequest>;

export const WalletSummary = z.object({
  id: Uuid,
  address: EvmAddress,
  network: Network,
  tokenContract: EvmAddress.nullable(),
  version: z.number().int().positive(),
  status: WalletStatus,
  confirmedAt: z.string().datetime().nullable(),
  supersededById: Uuid.nullable(),
});
export type WalletSummary = z.infer<typeof WalletSummary>;

/**
 * The credential ATS references on-chain via
 * `grantKyc(account, vcId, validFrom, validTo, issuer)`.
 *
 * Safe to disclose in full: every claim is a boolean, an enum, or an opaque
 * identifier. It asserts THAT checks passed, never the documents behind them
 * (D42).
 */
export const CredentialClaims = z.object({
  providerUserId: z.string(),
  verificationTier: VerificationTier,
  xmlSignatureVerified: z.boolean(),
  crossDocConsistent: z.boolean(),
  sameSubjectLinked: z.boolean(),
  walletControlProven: z.boolean(),
  identityBindingSigned: z.boolean(),
  callbackConfirmed: z.boolean(),
  addressVerifiedMethod: z.string(),
  country: CountryCode,
  onboardingSessionNonce: z.string(),
});
export type CredentialClaims = z.infer<typeof CredentialClaims>;

export const CredentialResponse = z.object({
  credentialId: Uuid,
  subjectAddress: EvmAddress,
  claims: CredentialClaims,
  signature: z.string(),
  /** Matches the `issuer` argument of the on-chain grant. */
  issuerAddress: EvmAddress,
  issuedAt: z.string().datetime(),
  /** From aadhaarKycTtl; becomes the on-chain validTo (D06). */
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  /** Set once the on-chain grant lands, so a re-run cannot double-grant. */
  grantedTxHash: z.string().nullable(),
  /** Not revoked and not expired — the platform's own gate before granting. */
  usable: z.boolean(),
});
export type CredentialResponse = z.infer<typeof CredentialResponse>;
