// Identity provider wire shapes (DigiLocker for India, generic elsewhere).
// Spec: docs/architecture.md §4.7

import { z } from "zod";
import { AddressVerifiedMethod, VerificationTier } from "./enums.js";
import { Uuid } from "./primitives.js";

export const DocType = z.enum(["aadhaar", "pan"]);
export type DocType = z.infer<typeof DocType>;

export const SessionStatus = z.enum(["created", "succeeded", "failed", "expired"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Normalised gender. Sources disagree: profile "male", Aadhaar "M", PAN "MALE" (D10). */
export const Gender = z.enum(["MALE", "FEMALE", "OTHER"]);
export type Gender = z.infer<typeof Gender>;

/** Aadhaar Poa fields. Government-attested postal address (§4.7). */
export const StructuredAddress = z.object({
  co: z.string().optional(),
  street: z.string().optional(),
  landmark: z.string().optional(),
  locality: z.string().optional(),
  vtc: z.string().optional(),
  po: z.string().optional(),
  subdist: z.string().optional(),
  dist: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  country: z.string().optional(),
});
export type StructuredAddress = z.infer<typeof StructuredAddress>;

/** POST /vendors/:id/identity/session */
export const StartIdentitySessionRequest = z.object({
  /**
   * Prefill only. There is no way to retrieve anyone's documents by phone
   * number — consent is mandatory and cannot be automated (§4.7).
   */
  mobile: z.string().regex(/^[0-9]{10}$/).optional(),
  docTypes: z.array(DocType).min(1),
});
export type StartIdentitySessionRequest = z.infer<typeof StartIdentitySessionRequest>;

export const StartIdentitySessionResponse = z.object({
  sessionId: z.string().min(1),
  /** The HUMAN opens this and consents. PKCE-protected, ~1 hour window. */
  authorizationUrl: z.string().url(),
});
export type StartIdentitySessionResponse = z.infer<typeof StartIdentitySessionResponse>;

/** GET /vendors/:id/identity/status */
export const IdentitySessionStatusResponse = z.object({
  sessionId: z.string().min(1),
  status: SessionStatus,
  consented: z.array(DocType),
});
export type IdentitySessionStatusResponse = z.infer<typeof IdentitySessionStatusResponse>;

/**
 * The four mandatory server-side checks (§4.7). Every one must pass before the
 * identity is usable; a failure returns 422 and nothing is persisted as
 * verified (D04).
 */
export const IdentityCheckResults = z.object({
  /** XMLDSig chain validated against the licensed CA root. */
  xmlSignatureVerified: z.boolean(),
  /** Name, DOB and gender agree across Aadhaar and PAN, after normalisation. */
  crossDocConsistent: z.boolean(),
  /** PAN `Person uid` equals the id inside the Aadhaar `KycRes txn` (D02). */
  sameSubjectLinked: z.boolean(),
  /** KycRes ttl captured — verification is time-bounded (D06). */
  ttlCaptured: z.boolean(),
});
export type IdentityCheckResults = z.infer<typeof IdentityCheckResults>;

/**
 * POST /vendors/:id/identity/complete
 *
 * Deliberately a summary, not the identity. The name, address, portrait and
 * PAN stay server-side, encrypted; what comes back is enough to render a status
 * page and nothing more (D06).
 */
export const CompleteIdentityResponse = z.object({
  vendorId: Uuid,
  /** Stable pseudonymous id — the identity primary key, never the Aadhaar number (D02). */
  providerUserId: z.string().min(1),
  documentsVerified: z.array(DocType),
  checks: IdentityCheckResults,
  aadhaarLast4: z.string().length(4).nullable(),
  addressVerifiedMethod: AddressVerifiedMethod,
  /** Re-verification deadline from KycRes ttl. */
  ttl: z.string().datetime().nullable(),
  resultingTier: VerificationTier,
});
export type CompleteIdentityResponse = z.infer<typeof CompleteIdentityResponse>;
