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

/**
 * The canonical string an entity name is hashed as (D62).
 *
 * The CRE enclave has no crypto — `node:crypto` is banned and no WebCrypto
 * global exists — so the match compares HMAC digests instead of decrypting
 * anything. That only works if two spellings of the same company reduce to
 * exactly one string.
 *
 * Dedupe + sort + join, because `nameSimilarity` compares token SETS: order and
 * repetition never affected the score, so they must not affect the digest
 * either. Without the sort, "Components Meridian" and "Meridian Components"
 * would hash differently while having scored 1.0.
 *
 * Returns null when nothing distinguishing survives. "Private Limited" reduces
 * to no tokens, and hashing the empty string would make every such name match
 * every other — the same trap `nameSimilarity` avoids by returning 0.
 */
export function canonicalEntityName(value: string): string | null {
  const tokens = [...new Set(normaliseEntityName(value))].sort();
  return tokens.length === 0 ? null : tokens.join(" ");
}
