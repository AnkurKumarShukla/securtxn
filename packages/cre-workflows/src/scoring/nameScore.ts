// Legal-entity name similarity.
//
// Shared by BOTH matcher implementations so the enclave and the fallback cannot
// silently disagree about what a match is (D09).
//
// This IS fuzzy, deliberately — and that is the opposite of the identity
// normaliser, which is exact. The difference is what the output gates:
//
//   identity/normalise/name.ts   boolean → blocks money. Exact, or one person's
//                                documents could vouch for another's.
//   this                         score → a human reads it, and REVERIFY sends
//                                it to review rather than sending funds.
//
// A registry writes "MERIDIAN COMPONENTS PRIVATE LIMITED" while an invoice says
// "Meridian Components Pvt Ltd". Those are the same company, and a system that
// cannot say so is a system nobody uses.

/**
 * Corporate form suffixes, stripped before comparison.
 *
 * They carry no distinguishing information — every company in a jurisdiction
 * shares them — but they dominate token overlap and would make two unrelated
 * "… Private Limited" firms look similar.
 */
const SUFFIXES = new Set([
  "pvt",
  "private",
  "ltd",
  "limited",
  "llp",
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "bv",
  "sa",
  "ag",
  "plc",
  "pte",
  "srl",
  "oy",
  "ab",
]);

export function normaliseEntityName(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,'"()&\-/]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !SUFFIXES.has(token));
}

/**
 * Similarity in [0, 1].
 *
 * Sørensen–Dice over token sets, which handles word reordering and extra
 * qualifiers without the brittleness of edit distance on long strings.
 *
 * Returns 0 — never a partial score — when either side has no distinguishing
 * tokens left. "Private Limited" against "Ltd" must not read as a perfect
 * match just because both reduce to nothing.
 */
export function nameSimilarity(left: string, right: string): number {
  const a = new Set(normaliseEntityName(left));
  const b = new Set(normaliseEntityName(right));

  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;

  return (2 * shared) / (a.size + b.size);
}
