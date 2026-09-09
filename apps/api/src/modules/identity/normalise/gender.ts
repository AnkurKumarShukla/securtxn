// Gender normalisation.
//
// Three representations of the same value across the endpoints (D10):
//
//   profile   male
//   Aadhaar   M
//   PAN       MALE
//
// Spec: docs/architecture.md §4.7.1

import type { Gender } from "@cp/shared-types";

const LOOKUP: Record<string, Gender> = {
  m: "MALE",
  male: "MALE",
  f: "FEMALE",
  female: "FEMALE",
  // UIDAI uses T for transgender; DigiLocker profiles have been seen to use
  // "other". Both map to the same value rather than being dropped.
  t: "OTHER",
  o: "OTHER",
  other: "OTHER",
  transgender: "OTHER",
};

/** Returns null for an unrecognised value — a check failure, not a crash. */
export function normaliseGender(input: unknown): Gender | null {
  if (typeof input !== "string") return null;
  return LOOKUP[input.trim().toLowerCase()] ?? null;
}

export function gendersMatch(left: unknown, right: unknown): boolean {
  const a = normaliseGender(left);
  const b = normaliseGender(right);
  return a !== null && a === b;
}
