// The match rule itself, as one pure function.
//
// There are three call sites — the fallback matcher, the TEE handler, and the
// DON handler — and they must never disagree. Previously each carried its own
// copy of the wallet-then-name logic, and D09's guarantee rested entirely on a
// shared test suite noticing if one drifted. A shared test only catches drift on
// cases it happens to cover; shared code cannot drift at all.
//
// DIGESTS, NOT NAMES (D62). The CRE enclave has no crypto: `node:crypto` is
// banned by the SDK and no WebCrypto global exists, so "encrypt at rest and
// decrypt inside the enclave" has nothing to decrypt with. Instead both sides
// are reduced to HMACs by the caller, and this function compares opaque bytes.
// No identity ever enters the enclave, and the pepper never leaves the server.
//
// What that costs: the near-miss band. Name matching used to be Sørensen–Dice
// ≥ minScore, so a typo scored ~0.95 and still passed while 0.5 went to a human.
// Digests are exact. Partly that is a gain — fuzzy matching is how lookalike
// payees slip through — but a reviewer can no longer tell a typo from a
// different company. A mismatch costs the sender a retry, never money.
//
// Deliberately pure: no I/O, no runtime, no secrets. The callers differ in how
// they FETCH the record (in-process, inside an enclave, or across DON nodes
// under consensus); what they do with it is identical.
//
// Spec: docs/architecture.md §4.4, docs/payment-flow.md P6

import type { VendorMatchInput, VendorMatchResult } from "./vendorMatch.js";

export const MATCH_REASONS = {
  VENDOR_NOT_FOUND: "VENDOR_NOT_FOUND",
  WALLET_NOT_ON_FILE: "WALLET_NOT_ON_FILE",
  /**
   * The name digest, the PAN digest, or both failed.
   *
   * ONE code on purpose, never per-field. The caller already learns one bit
   * from match/no-match; telling them WHICH field failed gives a second and
   * lets a prober hold the PAN constant while varying the name to isolate it
   * (D62).
   */
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  MATCHED: "MATCHED",
} as const;

/** The payee record as every lookup path returns it — digests only. */
export type VendorRecord = {
  /** HMAC(canonicalEntityName(legal name), pepper). Null when unverified. */
  legalNameHmac: string | null;
  /** HMAC(PAN, pepper). Null when the payee has no PAN on file. */
  panNumberHmac: string | null;
  wallets: { address: string; network: string; tokenContract: string | null }[];
};

/**
 * Constant-time-ish digest comparison.
 *
 * Both operands are hex HMACs of the same length, so this is not guarding a
 * secret an attacker can grind — but `===` on a digest is a habit worth not
 * forming, and the cost is nothing. Length is checked first so a truncated
 * value cannot short-circuit to true.
 */
function digestsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param vendor - the record on file, or null when the payee is unknown.
 */
export function evaluateMatch(
  input: VendorMatchInput,
  vendor: VendorRecord | null,
): VendorMatchResult {
  if (!vendor) {
    return { match: false, reasonCode: MATCH_REASONS.VENDOR_NOT_FOUND };
  }

  // The address is checked FIRST and exactly. A correct identity against a
  // wallet the payee never registered is the misdirection this product exists
  // to prevent — no amount of identity agreement may compensate for it.
  const walletOnFile = vendor.wallets.some(
    (wallet) =>
      wallet.address.toLowerCase() === input.walletAddress.toLowerCase() &&
      wallet.network === input.network &&
      // A token contract, when claimed, must also match what is on file:
      // right address, wrong asset is a distinct failure mode.
      (input.tokenContract === undefined ||
        (wallet.tokenContract ?? "").toLowerCase() === input.tokenContract.toLowerCase()),
  );

  if (!walletOnFile) {
    return { match: false, reasonCode: MATCH_REASONS.WALLET_NOT_ON_FILE };
  }

  // BOTH must agree. Either alone is insufficient: a shared company name is
  // common, and a PAN without the name would accept a payee who bought or
  // guessed the number.
  //
  // A null on the record side is a REFUSAL, not a pass. An unverified payee
  // with no digest on file must never satisfy a claim about them — that would
  // make "we have no data" indistinguishable from "the data agrees".
  const nameAgrees = digestsEqual(input.claimedNameHmac, vendor.legalNameHmac);
  const panAgrees = digestsEqual(input.claimedPanHmac, vendor.panNumberHmac);

  if (!nameAgrees || !panAgrees) {
    return { match: false, reasonCode: MATCH_REASONS.IDENTITY_MISMATCH };
  }

  return { match: true, reasonCode: MATCH_REASONS.MATCHED };
}
