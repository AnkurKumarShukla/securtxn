// Runs all four mandatory checks and reports one verdict.
//
// A failure of ANY check blocks CONFIRMED. There is no partial pass and no
// "verified with warnings" state: an identity that failed a check is not
// persisted as usable, and the endpoint returns 422 (D04).
//
// Spec: docs/architecture.md §4.7

import { createHash } from "node:crypto";
import type { IdentityCheckResults, StructuredAddress } from "@cp/shared-types";
import { parseAadhaar, type AadhaarDocument } from "../parse/aadhaar.js";
import { parsePan, type PanDocument } from "../parse/pan.js";
import type { UserProfile } from "../parse/profile.js";
import { checkCrossDocConsistency } from "./crossDocConsistency.js";
import { checkSameSubjectLinkage } from "./sameSubjectLinkage.js";
import { checkTtl } from "./ttl.js";
import { verifyXmlSignature, type TrustPolicy } from "./xmldsig.js";

export type IdentityCheckInput = {
  aadhaarXml: string;
  panXml: string;
  profile?: UserProfile;
  trustPolicy?: TrustPolicy;
  now?: Date;
};

export type IdentityCheckOutcome = {
  /** True only when all four checks pass. */
  passed: boolean;
  results: IdentityCheckResults;
  /** Human-readable failures, safe to log and return — field names, not values. */
  failures: string[];

  /** Extracted identity, populated regardless of pass/fail for diagnostics. */
  userId: string | null;
  aadhaarLast4: string | null;
  ttl: Date | null;
  legalName: string | null;
  dob: string | null;
  gender: string | null;
  address: StructuredAddress;
  photoBase64: string | null;
  panNumber: string | null;
  /**
   * SHA-256 of each raw document. Computed here because this is the last place
   * the raw XML exists — it is deliberately not retained. The IdentityBinding
   * attestation signs over these, so without them that signature cannot be
   * re-verified later (D03).
   */
  aadhaarDocHash: string;
  panDocHash: string;

  documents: { aadhaar: AadhaarDocument; pan: PanDocument };
};

export function runIdentityChecks(input: IdentityCheckInput): IdentityCheckOutcome {
  const now = input.now ?? new Date();
  const failures: string[] = [];

  const aadhaar = parseAadhaar(input.aadhaarXml);
  const pan = parsePan(input.panXml);

  // 1. Signature. Both documents, independently — a valid Aadhaar says nothing
  //    about the PAN accompanying it.
  const aadhaarSig = verifyXmlSignature(input.aadhaarXml, input.trustPolicy, now);
  const panSig = verifyXmlSignature(input.panXml, input.trustPolicy, now);
  const xmlSignatureVerified = aadhaarSig.verified && panSig.verified;
  if (!aadhaarSig.verified) failures.push(`aadhaar signature: ${aadhaarSig.reasons.join("; ")}`);
  if (!panSig.verified) failures.push(`pan signature: ${panSig.reasons.join("; ")}`);

  // 2. Consistency, after normalisation.
  const consistency = checkCrossDocConsistency(aadhaar, pan, input.profile);
  if (!consistency.consistent) {
    if (consistency.mismatchedFields.length > 0) {
      failures.push(`fields disagree between documents: ${consistency.mismatchedFields.join(", ")}`);
    }
    if (consistency.missingFields.length > 0) {
      failures.push(`fields missing and not comparable: ${consistency.missingFields.join(", ")}`);
    }
  }

  // 3. Same subject.
  const linkage = checkSameSubjectLinkage(aadhaar, pan);
  if (!linkage.linked) failures.push(`same-subject linkage: ${linkage.reason ?? "failed"}`);

  // 4. TTL. An expired document is not a usable identity.
  const ttl = checkTtl(aadhaar, now);
  if (!ttl.captured) failures.push(`ttl: ${ttl.reason ?? "not captured"}`);
  else if (ttl.expired) failures.push(`ttl: ${ttl.reason ?? "expired"}`);

  const results: IdentityCheckResults = {
    xmlSignatureVerified,
    crossDocConsistent: consistency.consistent,
    sameSubjectLinked: linkage.linked,
    ttlCaptured: ttl.captured && !ttl.expired,
  };

  return {
    passed: Object.values(results).every(Boolean),
    results,
    failures,
    userId: linkage.userId,
    aadhaarLast4: aadhaar.last4,
    ttl: ttl.ttl,
    // Prefer the Aadhaar for identity fields: it is the UIDAI-issued source and
    // the one carrying the attested address.
    legalName: aadhaar.name,
    dob: aadhaar.dob,
    gender: aadhaar.gender,
    address: aadhaar.address,
    photoBase64: aadhaar.photoBase64,
    panNumber: pan.panNumber,
    aadhaarDocHash: sha256Hex(input.aadhaarXml),
    panDocHash: sha256Hex(input.panXml),
    documents: { aadhaar, pan },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export { checkCrossDocConsistency } from "./crossDocConsistency.js";
export { checkSameSubjectLinkage } from "./sameSubjectLinkage.js";
export { checkTtl } from "./ttl.js";
export { verifyXmlSignature, DIGILOCKER_TRUST_POLICY } from "./xmldsig.js";
