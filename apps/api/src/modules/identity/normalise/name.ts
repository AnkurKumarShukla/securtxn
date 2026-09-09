// Name normalisation.
//
// Case differs by source (D10):
//
//   Aadhaar   Ankur Kumar Shukla
//   PAN       ANKUR KUMAR SHUKLA
//
// Spec: docs/architecture.md §4.7.1

/**
 * Casefolds, collapses internal whitespace, and strips punctuation that varies
 * between registries (initials written "A.K." vs "A K").
 *
 * Deliberately NOT a fuzzy match. This function decides whether two government
 * documents describe the same person, and a similarity threshold here would
 * let "Ankur Kumar" pass against "Ankur Kumari". Fuzzy scoring belongs in
 * vendor matching, where the output is a score a human reviews — not in a
 * consistency check whose output is a boolean that gates money.
 */
export function normaliseName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalised = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalised === "" ? null : normalised;
}

export function namesMatch(left: unknown, right: unknown): boolean {
  const a = normaliseName(left);
  const b = normaliseName(right);
  return a !== null && a === b;
}
