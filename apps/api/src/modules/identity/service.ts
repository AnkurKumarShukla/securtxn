// Identity flow orchestration.
//
// The provider fetches and checks; this decides what is allowed to persist.
// The rule is absolute: if any of the four mandatory checks failed, nothing is
// stored as verified and the caller gets 422. There is no "pending review"
// row, because a half-verified identity sitting in the table looks verified to
// every later query (D04).
//
// Spec: docs/architecture.md §4.1, §4.7

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { CompleteIdentityResponse, DocType, VerificationTier } from "@cp/shared-types";
import { canonicalEntityName } from "@cp/cre-workflows";
import type { Config } from "../../config/index.js";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import { encrypt, encryptJson, hmac } from "../../lib/crypto.js";
import type { IdentityProvider, IdentityResult } from "./IdentityProvider.js";
import { toIsoDate } from "./normalise/index.js";

export type IdentityServiceDeps = {
  prisma: PrismaClient;
  provider: IdentityProvider;
  config: Config;
};

export class IdentityService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  /**
   * Starts a provider session against a vendor.
   *
   * The vendor's `onboardingSessionNonce` is issued here if it does not exist
   * yet, and carried into the provider's redirect state. Every later artifact —
   * liveness capture, wallet signature — must present the same nonce, which is
   * what binds them to one subject rather than three independent facts (D03).
   */
  async startSession(
    vendorId: string,
    input: { mobile?: string; docTypes: DocType[] },
  ): Promise<{ sessionId: string; authorizationUrl: string; onboardingSessionNonce: string }> {
    const vendor = await this.requireVendor(vendorId);

    const nonce = vendor.onboardingSessionNonce ?? `0x${randomBytes(32).toString("hex")}`;

    const session = await this.deps.provider.startSession({
      ...(input.mobile ? { mobile: input.mobile } : {}),
      docTypes: input.docTypes,
    });

    await this.deps.prisma.vendor.update({
      where: { id: vendorId },
      data: { onboardingSessionNonce: nonce, digilockerSessionId: session.sessionId },
    });

    return { ...session, onboardingSessionNonce: nonce };
  }

  async getStatus(vendorId: string): Promise<{ sessionId: string; status: string; consented: string[] }> {
    const vendor = await this.requireVendor(vendorId);
    if (!vendor.digilockerSessionId) {
      throw new UnprocessableError("No identity session has been started for this vendor");
    }

    const status = await this.deps.provider.getStatus(vendor.digilockerSessionId);
    return { sessionId: vendor.digilockerSessionId, ...status };
  }

  /**
   * Fetches the consented documents, runs every mandatory check, and persists
   * only on a clean pass.
   */
  async complete(vendorId: string): Promise<CompleteIdentityResponse> {
    const vendor = await this.requireVendor(vendorId);
    if (!vendor.digilockerSessionId) {
      throw new UnprocessableError("No identity session has been started for this vendor");
    }

    const identity = await this.deps.provider.fetchIdentity(vendor.digilockerSessionId);

    // 422, not 400: the request was well-formed. What failed is the evidence.
    if (!allChecksPassed(identity)) {
      throw new UnprocessableError("Identity verification failed", {
        checks: identity.checks,
        failures: identity.failures,
      });
    }

    // One DigiLocker account may back exactly one vendor. Two vendors sharing
    // an identity is either a duplicate registration or an attempt to reuse
    // someone else's completed KYC (D03).
    const existing = await this.deps.prisma.vendor.findUnique({
      where: { digilockerUserId: identity.providerUserId },
    });
    if (existing && existing.id !== vendorId) {
      throw new ConflictError("This identity is already registered to another vendor");
    }

    const now = new Date();
    const key = this.deps.config.PII_ENCRYPTION_KEY;
    const hasAttestedAddress = Object.keys(identity.address ?? {}).length > 0;

    const updated = await this.deps.prisma.$transaction(async (tx) => {
      // The portrait goes to the blob store; the vendor row keeps only its id.
      let photoRef: string | null = vendor.photoEncryptedRef;
      if (identity.photoBase64) {
        const raw = Buffer.from(identity.photoBase64, "base64");
        const sealed = encrypt(raw, key);
        const blob = await tx.encryptedBlob.create({
          data: {
            kind: "IDENTITY_PHOTO",
            ciphertext: toBytes(sealed.ciphertext),
            iv: toBytes(sealed.iv),
            authTag: toBytes(sealed.authTag),
            contentType: "image/jpeg",
            byteLength: raw.byteLength,
          },
        });
        photoRef = blob.id;
      }

      return tx.vendor.update({
        where: { id: vendorId },
        data: {
          digilockerUserId: identity.providerUserId,
          aadhaarLast4: identity.aadhaarLast4 ?? null,
          aadhaarKycTtl: identity.ttl ?? null,

          // Never plaintext: matched by digest, never read back (D06).
          panNumberHmac: identity.taxId
            ? hmac(identity.taxId, this.deps.config.HMAC_PEPPER)
            : null,
          panVerifiedOn: now,

          // The name digest the payment match compares against (D62).
          //
          // Hashed from the DIGILOCKER-VERIFIED name, not the self-declared one
          // captured at vendor creation — a payee could type anything there, and
          // the whole value of the check is that both sides are compared against
          // something a government issuer attested.
          //
          // canonicalEntityName strips corporate suffixes and sorts the tokens,
          // so "Meridian Components Pvt Ltd" and "MERIDIAN COMPONENTS PRIVATE
          // LIMITED" reduce to one string and therefore one digest. Null when
          // nothing distinguishing survives ("Private Limited" alone), which
          // fails the match closed rather than matching everything.
          legalNameHmac: (() => {
            const canonical = canonicalEntityName(identity.legalName);
            return canonical ? hmac(canonical, this.deps.config.HMAC_PEPPER) : null;
          })(),

          idDocumentType: "DIGILOCKER_AADHAAR",
          // Signed over by the IdentityBinding attestation (D03); the raw
          // documents are not retained, so these are the only way to rebuild
          // and re-verify that payload later.
          aadhaarDocHash: identity.aadhaarDocHash ?? null,
          panDocHash: identity.panDocHash ?? null,

          // The DigiLocker-linked mobile. Independent of anything submitted
          // with a wallet, which is what makes it usable as a callback channel
          // for an individual payee (D05).
          ...(identity.mobile
            ? {
                verifiedPhone: serialise(encrypt(identity.mobile, key)),
                verifiedPhoneAt: now,
              }
            : {}),
          xmlSignatureVerified: true,
          xmlSignatureVerifiedAt: now,
          crossDocConsistent: true,

          dobEncrypted: identity.dob
            ? serialise(encrypt(toIsoDate(identity.dob) ?? identity.dob, key))
            : null,
          // Json column: omit the key entirely rather than writing undefined,
          // which Prisma cannot distinguish from "set to JSON null".
          ...(hasAttestedAddress
            ? { verifiedAddressEncrypted: serialise(encryptJson(identity.address, key)) }
            : {}),
          addressVerifiedMethod: hasAttestedAddress ? "ID_DOCUMENT" : "UNVERIFIED",
          addressVerifiedAt: hasAttestedAddress ? now : null,

          photoEncryptedRef: photoRef,
          verificationTier: tierFor(hasAttestedAddress),
        },
      });
    });

    return {
      vendorId: updated.id,
      providerUserId: identity.providerUserId,
      documentsVerified: identity.documentsVerified as DocType[],
      checks: identity.checks,
      aadhaarLast4: updated.aadhaarLast4,
      addressVerifiedMethod: updated.addressVerifiedMethod ?? "UNVERIFIED",
      ttl: updated.aadhaarKycTtl?.toISOString() ?? null,
      resultingTier: updated.verificationTier,
    };
  }

  private async requireVendor(vendorId: string) {
    const vendor = await this.deps.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundError(`Vendor '${vendorId}'`);
    return vendor;
  }
}

function allChecksPassed(identity: IdentityResult): boolean {
  return Object.values(identity.checks).every(Boolean);
}

/**
 * Tier describes what the IDENTITY evidence proves, and nothing else.
 *
 * A DigiLocker Aadhaar carries a government-attested postal address (Poa), so a
 * clean pass reaches TIER3_ADDRESS in one step — the postcard-code path is
 * unnecessary for India (§4.7).
 *
 * Wallet binding is deliberately NOT folded in here. It is tracked on
 * `VendorWallet.status`, and the decision engine requires both: a CONFIRMED
 * wallet AND a sufficient tier (§4.1). Collapsing them into one field would
 * make a verified identity look like an authorised payout address.
 */
function tierFor(hasAttestedAddress: boolean): VerificationTier {
  return hasAttestedAddress ? "TIER3_ADDRESS" : "TIER2_IDENTITY";
}

/**
 * Prisma's `Bytes` column expects a Uint8Array backed by a plain ArrayBuffer,
 * while Node hands back Buffers that may share one. Copy at the boundary.
 */
function toBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const owned = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(owned);
  view.set(buffer);
  return view;
}

/** Ciphertext as a single self-describing string: iv.authTag.ciphertext, base64. */
function serialise(sealed: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }): string {
  return [
    sealed.iv.toString("base64"),
    sealed.authTag.toString("base64"),
    sealed.ciphertext.toString("base64"),
  ].join(".");
}
