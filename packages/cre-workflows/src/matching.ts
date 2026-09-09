// The match rule itself, as one pure function.
//
// There are three call sites — the fallback matcher, the TEE handler, and the
// DON handler — and they must never disagree. Previously each carried its own
// copy of the wallet-then-name logic, and D09's guarantee rested entirely on
// a shared test suite noticing if one drifted. A shared test only catches
// drift on cases it happens to cover; shared code cannot drift at all.
//
// Deliberately pure: no I/O, no runtime, no secrets. The callers differ in how
// they *fetch* the vendor record (in-process, inside an enclave, or across DON
// nodes under consensus); what they do with it is identical.
//
// Spec: docs/architecture.md §4.4

import { nameSimilarity } from "./scoring/index.js";
import type { VendorMatchInput, VendorMatchResult } from "./vendorMatch.js";

export const MATCH_REASONS = {
  VENDOR_NOT_FOUND: "VENDOR_NOT_FOUND",
  WALLET_NOT_ON_FILE: "WALLET_NOT_ON_FILE",
  NAME_BELOW_THRESHOLD: "NAME_BELOW_THRESHOLD",
  MATCHED: "MATCHED",
} as const;

/** The vendor record as every lookup path returns it. */
export type VendorRecord = {
  legalName: string;
  wallets: { address: string; network: string; tokenContract: string | null }[];
};

/**
 * @param vendor - the record on file, or null when the vendor is unknown.
 * @param minScore - risk appetite, not a constant (D08).
 */
export function evaluateMatch(
  input: VendorMatchInput,
  vendor: VendorRecord | null,
  minScore: number,
): VendorMatchResult {
  if (!vendor) {
    return { match: false, score: 0, reasonCode: MATCH_REASONS.VENDOR_NOT_FOUND };
  }

  // The address is checked FIRST and exactly. A high name score against a
  // wallet the vendor never registered is the misdirection this product exists
  // to prevent — no amount of name similarity may compensate for it.
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
    return { match: false, score: 0, reasonCode: MATCH_REASONS.WALLET_NOT_ON_FILE };
  }

  const score = nameSimilarity(input.claimedLegalName, vendor.legalName);

  if (score < minScore) {
    // Score is still reported. The decision engine turns this into REVERIFY,
    // and a human needs the number to judge "typo" against "wrong company".
    return { match: false, score, reasonCode: MATCH_REASONS.NAME_BELOW_THRESHOLD };
  }

  return { match: true, score, reasonCode: MATCH_REASONS.MATCHED };
}
