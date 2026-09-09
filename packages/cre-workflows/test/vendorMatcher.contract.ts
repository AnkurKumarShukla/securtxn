// The shared contract both VendorMatcher implementations must satisfy
// identically (D09). This is not a test FILE — vitest only collects
// `*.test.ts` — it is imported and invoked by one per implementation:
//
//   fallback.test.ts   runVendorMatcherContract("FallbackVendorMatcher", ...)
//   cre.test.ts        runVendorMatcherContract("CreVendorMatcher", ...)        (once built)
//
// Same inputs, same assertions, same file. If the two implementations ever
// disagree on a verdict, one of these two test files fails — nothing else
// has to change for that guarantee to hold.

import { describe, expect, it } from "vitest";
import { MATCH_REASONS } from "../src/fallback/FallbackVendorMatcher.js";
import type { VendorLookup, VendorMatcher } from "../src/vendorMatch.js";

type VendorRecord = { legalName: string; wallets: { address: string; network: string; tokenContract: string | null }[] };

const CONFIRMED_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER_WALLET = "0x1234567890123456789012345678901234567890";
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETHEREUM = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

function vendorLookupOf(record: VendorRecord | null): VendorLookup {
  return async () => record;
}

/**
 * @param label      Shown in test output — the implementation under test.
 * @param createMatcher  Builds the matcher from a lookup, e.g.
 *                       `(lookup) => new FallbackVendorMatcher({ lookup, minScore: 0.7 })`.
 *                       The min-score threshold is fixed at 0.7 here so both
 *                       implementations are compared under identical config,
 *                       not just identical code.
 */
export function runVendorMatcherContract(
  label: string,
  createMatcher: (lookup: VendorLookup) => VendorMatcher,
) {
  describe(`VendorMatcher contract — ${label}`, () => {
    it("fails closed when the vendor does not exist", async () => {
      const matcher = createMatcher(vendorLookupOf(null));
      const result = await matcher.match({
        vendorId: "missing",
        claimedLegalName: "Anything Pvt Ltd",
        walletAddress: CONFIRMED_WALLET,
        network: "ethereum",
      });
      expect(result).toEqual({ match: false, score: 0, reasonCode: MATCH_REASONS.VENDOR_NOT_FOUND });
    });

    it("refuses a wallet the vendor never registered, regardless of name", async () => {
      // The misdirection this product exists to prevent: a perfect name match
      // against the WRONG address must never pass. No amount of name
      // similarity may compensate for an unregistered address.
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Meridian Components Pvt Ltd",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: null }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Meridian Components Pvt Ltd", // exact name match
        walletAddress: OTHER_WALLET, // wrong address
        network: "ethereum",
      });
      expect(result.match).toBe(false);
      expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
    });

    it("refuses when the network does not match, even at the same address", async () => {
      // Same address string can exist on multiple chains. Right address,
      // wrong network is not the same wallet.
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Meridian Components Pvt Ltd",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: null }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Meridian Components Pvt Ltd",
        walletAddress: CONFIRMED_WALLET,
        network: "polygon",
      });
      expect(result.match).toBe(false);
      expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
    });

    it("refuses when the claimed token contract does not match what is on file", async () => {
      // Right address, wrong asset — a distinct failure mode from a wrong
      // address, and one that must be caught with the same severity.
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Meridian Components Pvt Ltd",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: USDC_ETHEREUM }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Meridian Components Pvt Ltd",
        walletAddress: CONFIRMED_WALLET,
        network: "ethereum",
        tokenContract: USDT_ETHEREUM,
      });
      expect(result.match).toBe(false);
      expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
    });

    it("is case-insensitive on address and token contract, but not on network", async () => {
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Meridian Components Pvt Ltd",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: USDC_ETHEREUM }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Meridian Components Pvt Ltd",
        walletAddress: CONFIRMED_WALLET.toLowerCase(),
        network: "ethereum",
        tokenContract: USDC_ETHEREUM.toLowerCase(),
      });
      expect(result.match).toBe(true);
    });

    it("sends a name mismatch to review with the score attached, not a silent false", async () => {
      // A wrong-looking name is frequently a typo or trading-name difference.
      // The caller (the decision engine) needs the number to send this to a
      // human as REVERIFY, not to treat it identically to no-match-at-all.
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Meridian Components Pvt Ltd",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: null }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Totally Different Corp",
        walletAddress: CONFIRMED_WALLET,
        network: "ethereum",
      });
      expect(result.match).toBe(false);
      expect(result.reasonCode).toBe(MATCH_REASONS.NAME_BELOW_THRESHOLD);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThan(0.7);
    });

    it("matches despite corporate-suffix and casing differences", async () => {
      // A registry writes "MERIDIAN COMPONENTS PRIVATE LIMITED"; an invoice
      // says "Meridian Components Pvt Ltd". Same company — a matcher that
      // cannot see that is a matcher nobody can actually use.
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "MERIDIAN COMPONENTS PRIVATE LIMITED",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: null }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Meridian Components Pvt Ltd",
        walletAddress: CONFIRMED_WALLET,
        network: "ethereum",
      });
      expect(result.match).toBe(true);
      expect(result.reasonCode).toBe(MATCH_REASONS.MATCHED);
    });

    it("does not let two names that both reduce to nothing but suffixes score as a match", async () => {
      // "Private Limited" against "Ltd" must not read as a perfect match just
      // because both strip down to zero distinguishing tokens.
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Private Limited",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: null }],
        }),
      );
      const result = await matcher.match({
        vendorId: "v1",
        claimedLegalName: "Ltd",
        walletAddress: CONFIRMED_WALLET,
        network: "ethereum",
      });
      expect(result.match).toBe(false);
      expect(result.score).toBe(0);
    });

    it("is deterministic — the same input always yields the same verdict", async () => {
      const matcher = createMatcher(
        vendorLookupOf({
          legalName: "Meridian Components Pvt Ltd",
          wallets: [{ address: CONFIRMED_WALLET, network: "ethereum", tokenContract: null }],
        }),
      );
      const query = {
        vendorId: "v1",
        claimedLegalName: "Meridian Components Pvt Ltd",
        walletAddress: CONFIRMED_WALLET,
        network: "ethereum",
      };
      const first = await matcher.match(query);
      const second = await matcher.match(query);
      expect(second).toEqual(first);
    });
  });
}
