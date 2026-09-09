// DigiLocker user profile parser.
//
// The profile is JSON, not XML, and it is NOT signed — it is convenience data
// from the aggregator. Treat it as a claim to cross-check against the signed
// documents, never as a source of truth on its own (D04).
//
// Spec: docs/architecture.md §4.7.1

import { z } from "zod";

/**
 * date_of_birth is documented as a unix-ms timestamp but came back as
 * "DD/MM/YYYY" in the live capture, so both types are accepted here and
 * resolved by the normaliser (D10).
 */
const ProfileData = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  date_of_birth: z.union([z.string(), z.number()]).optional(),
  gender: z.string().optional(),
  mobile: z.string().optional(),
  email: z.string().optional(),
  eaadhaar: z.union([z.boolean(), z.string()]).optional(),
});

const ProfileEnvelope = z.object({
  code: z.number().optional(),
  data: ProfileData,
});

export type UserProfile = {
  providerProfileId: string | null;
  name: string | null;
  dob: string | number | null;
  gender: string | null;
  mobile: string | null;
  email: string | null;
};

export function parseProfile(payload: unknown): UserProfile {
  // Accept either the full response envelope or a bare data object, since the
  // fixture files store the envelope and a live client may hand over either.
  const envelope = ProfileEnvelope.safeParse(payload);
  const data = envelope.success ? envelope.data.data : ProfileData.parse(payload);

  return {
    providerProfileId: data.id ?? null,
    name: data.name ?? null,
    dob: data.date_of_birth ?? null,
    gender: data.gender ?? null,
    mobile: data.mobile ?? null,
    email: data.email && data.email !== "" ? data.email : null,
  };
}
