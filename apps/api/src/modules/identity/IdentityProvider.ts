// The identity provider contract. DigiLocker, generic KYC and mock all satisfy
// it and all pass the same test suite.
// Spec: docs/architecture.md §4.7

import type { IdentityCheckResults, StructuredAddress } from "@cp/shared-types";


export type { StructuredAddress };

export type IdentityResult = {
  /** Stable pseudonymous id -> Vendor.digilockerUserId. Never the Aadhaar number. */
  providerUserId: string;
  legalName: string;
  /** ISO date. Normalise before populating — sources disagree on format. */
  dob: string;
  gender: string;
  address?: StructuredAddress;
  photoBase64?: string;
  /** PAN for India. */
  taxId?: string;
  documentsVerified: string[];
  /**
   * Same value as `checks.xmlSignatureVerified`, kept because §4.7 names it on
   * the interface. False here must block CONFIRMED.
   */
  signatureVerified: boolean;
  /**
   * Every mandatory check, individually. The caller needs the breakdown to
   * report WHICH check failed — "identity rejected" with no reason is not
   * actionable for an operator (D04).
   */
  checks: IdentityCheckResults;
  /** Last four digits only. The full number is never received (D02). */
  aadhaarLast4?: string;
  /** SHA-256 of each raw document; signed over by the IdentityBinding (D03). */
  aadhaarDocHash?: string;
  panDocHash?: string;
  /** DigiLocker-verified mobile — an independent contact for callback (D05). */
  mobile?: string;
  /** Field-level failure descriptions, safe to log — names, never values. */
  failures: string[];
  /** Re-verification deadline. CONFIRMED is time-bounded, not permanent. */
  ttl?: Date;
};

export type SessionStatus = "created" | "succeeded" | "failed" | "expired";

export interface IdentityProvider {
  startSession(input: { mobile?: string; docTypes: string[] }): Promise<{
    sessionId: string;
    authorizationUrl: string;
  }>;
  getStatus(sessionId: string): Promise<{
    status: SessionStatus;
    consented: string[];
  }>;
  fetchIdentity(sessionId: string): Promise<IdentityResult>;
}
