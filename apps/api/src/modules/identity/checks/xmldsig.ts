// Check 1 of 4: XMLDSig signature verification.
//
// This is the check that makes the other three meaningful. Parsing a DigiLocker
// XML without verifying its signature throws away the entire security property:
// an unverified document is a text file anyone can write, and its name, address
// and date of birth are then attacker-controlled (D04).
//
// Two separate questions, deliberately kept apart:
//
//   1. INTEGRITY — does the signature verify against the certificate embedded
//      in the document? This proves the bytes were not altered after signing.
//      It proves nothing about who signed.
//   2. TRUST — is that certificate one we accept? A self-signed certificate
//      produces a perfectly valid signature over a forged document.
//
// Only both together may set `xmlSignatureVerified`.
//
// Spec: docs/architecture.md §4.7

import { X509Certificate } from "node:crypto";
import { XMLSerializer } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { firstElement, parseXml, textOf } from "../parse/xml.js";

export type SignatureVerification = {
  /** Signature verifies against the embedded certificate. */
  integrityValid: boolean;
  /** The embedded certificate is one we accept. */
  trusted: boolean;
  /** integrityValid && trusted — the value that may be persisted. */
  verified: boolean;
  signerSubject: string | null;
  signerIssuer: string | null;
  certificateValidFrom: string | null;
  certificateValidTo: string | null;
  /** SHA-256 fingerprint of the signing certificate, for pinning and audit. */
  fingerprint256: string | null;
  reasons: string[];
};

export type TrustPolicy = {
  /**
   * Substrings that must appear in the signing certificate's subject.
   * Observed subject: "CN=DS DIGITAL INDIA CORPORATION,emailAddress=...".
   */
  requiredSubjectFragments: string[];
  /**
   * Accepted SHA-256 fingerprints. When non-empty this is authoritative and the
   * subject check becomes advisory — pinning is strictly stronger than matching
   * a distinguished name, which an attacker can simply put in their own cert.
   */
  pinnedFingerprints: string[];
  /** Reject a document signed by an expired certificate. */
  requireCurrentValidity: boolean;
};

/**
 * Default policy for DigiLocker-issued documents.
 *
 * DigiLocker signs on behalf of the issuer, so the certificate says DIGITAL
 * INDIA CORPORATION rather than UIDAI or the Income Tax Department. Only one
 * certificate is embedded — the intermediate and root are not included — so
 * full path validation to an Indian CA root needs those roots supplied out of
 * band. Until they are, subject matching plus optional fingerprint pinning is
 * the honest ceiling, and this comment is here so nobody later mistakes that
 * for full PKI path validation.
 */
export const DIGILOCKER_TRUST_POLICY: TrustPolicy = {
  requiredSubjectFragments: ["DIGITAL INDIA CORPORATION"],
  pinnedFingerprints: [],
  requireCurrentValidity: true,
};

export function verifyXmlSignature(
  raw: string,
  policy: TrustPolicy = DIGILOCKER_TRUST_POLICY,
  now: Date = new Date(),
): SignatureVerification {
  const reasons: string[] = [];
  const failure = (reason: string): SignatureVerification => {
    reasons.push(reason);
    return {
      integrityValid: false,
      trusted: false,
      verified: false,
      signerSubject: null,
      signerIssuer: null,
      certificateValidFrom: null,
      certificateValidTo: null,
      fingerprint256: null,
      reasons,
    };
  };

  const doc = parseXml(raw);
  const signatureNode = firstElement(doc, "Signature");
  if (!signatureNode) return failure("document carries no <Signature> element");

  const certificateBase64 = textOf(firstElement(doc, "X509Certificate"));
  if (!certificateBase64) return failure("signature carries no <X509Certificate>");

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(toPem(certificateBase64));
  } catch (err) {
    return failure(`embedded certificate could not be parsed: ${asMessage(err)}`);
  }

  // --- 1. integrity -------------------------------------------------------
  let integrityValid = false;
  try {
    const verifier = new SignedXml();
    verifier.publicCert = certificate.toString();
    // Serialized rather than passed as a DOM node: this package has no DOM lib,
    // and xml-crypto accepts the signature XML as a string.
    verifier.loadSignature(new XMLSerializer().serializeToString(signatureNode));
    integrityValid = verifier.checkSignature(raw);
    if (!integrityValid) {
      reasons.push("signature or digest did not verify against the embedded certificate");
    }
  } catch (err) {
    reasons.push(`signature verification threw: ${asMessage(err)}`);
  }

  // --- 2. trust -----------------------------------------------------------
  const fingerprint256 = certificate.fingerprint256;
  const subject = certificate.subject.replace(/\r?\n/g, ",");
  const issuer = certificate.issuer.replace(/\r?\n/g, ",");

  let trusted: boolean;
  if (policy.pinnedFingerprints.length > 0) {
    trusted = policy.pinnedFingerprints.some((f) => equalsIgnoreCase(f, fingerprint256));
    if (!trusted) reasons.push("signing certificate is not in the pinned fingerprint set");
  } else {
    trusted = policy.requiredSubjectFragments.every((fragment) =>
      subject.toUpperCase().includes(fragment.toUpperCase()),
    );
    if (!trusted) reasons.push(`signing certificate subject is not an accepted issuer: ${subject}`);
  }

  if (policy.requireCurrentValidity) {
    const from = new Date(certificate.validFrom);
    const to = new Date(certificate.validTo);
    if (now < from || now > to) {
      trusted = false;
      reasons.push(`signing certificate is outside its validity window (${certificate.validTo})`);
    }
  }

  return {
    integrityValid,
    trusted,
    verified: integrityValid && trusted,
    signerSubject: subject,
    signerIssuer: issuer,
    certificateValidFrom: certificate.validFrom,
    certificateValidTo: certificate.validTo,
    fingerprint256,
    reasons,
  };
}

function toPem(base64: string): string {
  const body = base64.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.replace(/:/g, "").toLowerCase() === b.replace(/:/g, "").toLowerCase();
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
