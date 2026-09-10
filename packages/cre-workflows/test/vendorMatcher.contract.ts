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
//
// DIGESTS, NOT NAMES (D62). Everything identity-shaped is an HMAC computed by
// the caller, because the CRE enclave has no crypto to decrypt with. The
// comparison is therefore exact: there is no score and no threshold, so the
// two implementations no longer even have a knob that could be set differently.

import { describe, expect, it } from "vitest";
import { MATCH_REASONS } from "../src/fallback/FallbackVendorMatcher.js";
import { canonicalEntityName } from "../src/scoring/index.js";
import type { VendorLookup, VendorMatcher } from "../src/vendorMatch.js";

const CONFIRMED_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER_WALLET = "0x1234567890123456789012345678901234567890";
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETHEREUM = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

/**
 * A stand-in for HMAC(value, pepper).
 *
 * The real digest is keyed, but nothing in the match rule depends on HOW the
 * digest was produced — only that both sides used the same function. Using a
 * transparent one here keeps the tests readable and, more usefully, means a
 * test asserting "these two spellings agree" is really asserting that
 * canonicalisation collapsed them, not that some hash happened to collide.
 */
const digest = (value: string) => `d:${value}`;

/** What the server does before calling: canonicalise, then hash. */
function nameDigest(name: string): string | null {
  const canonical = canonicalEntityName(name);
  return canonical ? digest(canonical) : null;
}

type VendorRecord = {
  legalNameHmac: string | null;
  panNumberHmac: string | null;
  wallets: { address: string; network: string; tokenContract: string | null }[];
};

function vendorLookupOf(record: VendorRecord | null): VendorLookup {
  return async () => record;
}

const PAYEE_NAME = "Meridian Components Pvt Ltd";
const PAYEE_PAN = "ABCDE1234F";

/** The payee exactly as onboarding would have written them. */
function payeeOnFile(overrides: Partial<VendorRecord> = {}): VendorRecord {
  return {
    legalNameHmac: nameDigest(PAYEE_NAME),
    panNumberHmac: digest(PAYEE_PAN),
    wallets: [
      { address: CONFIRMED_WALLET, network: "ethereum", tokenContract: USDC_ETHEREUM },
    ],
    ...overrides,
  };
}

/** A well-formed claim about that payee. */
function claim(overrides: Record<string, unknown> = {}) {
  return {
    vendorId: "vendor-1",
    claimedNameHmac: nameDigest(PAYEE_NAME)!,
    claimedPanHmac: digest(PAYEE_PAN),
    walletAddress: CONFIRMED_WALLET,
    network: "ethereum",
    tokenContract: USDC_ETHEREUM,
    ...overrides,
  };
}

export function runVendorMatcherContract(
  label: string,
  createMatcher: (lookup: VendorLookup) => VendorMatcher,
) {
  describe(`VendorMatcher contract — ${label}`, () => {
    it("matches when the wallet, name digest and PAN digest all agree", async () => {
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      expect(await matcher.match(claim())).toEqual({
        match: true,
        reasonCode: MATCH_REASONS.MATCHED,
      });
    });

    it("fails closed when the vendor does not exist", async () => {
      const matcher = createMatcher(vendorLookupOf(null));
      expect(await matcher.match(claim({ vendorId: "missing" }))).toEqual({
        match: false,
        reasonCode: MATCH_REASONS.VENDOR_NOT_FOUND,
      });
    });

    it("refuses a wallet the payee never registered", async () => {
      // The misdirection this product exists to prevent. No amount of identity
      // agreement may compensate for the wrong address.
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      expect(await matcher.match(claim({ walletAddress: OTHER_WALLET }))).toEqual({
        match: false,
        reasonCode: MATCH_REASONS.WALLET_NOT_ON_FILE,
      });
    });

    it("checks the wallet BEFORE the identity", async () => {
      // Ordering is load-bearing: a wrong address with a wrong identity must
      // report the address, because that is the actionable fault.
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      const result = await matcher.match(
        claim({ walletAddress: OTHER_WALLET, claimedPanHmac: digest("ZZZZZ9999Z") }),
      );
      expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
    });

    it("is case-insensitive on address and token contract, but not on network", async () => {
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));

      await expect(
        matcher.match(
          claim({
            walletAddress: CONFIRMED_WALLET.toLowerCase(),
            tokenContract: USDC_ETHEREUM.toLowerCase(),
          }),
        ),
      ).resolves.toMatchObject({ match: true });

      // Network is an identifier, not an address. "Ethereum" is not a chain.
      await expect(matcher.match(claim({ network: "Ethereum" }))).resolves.toMatchObject({
        match: false,
        reasonCode: MATCH_REASONS.WALLET_NOT_ON_FILE,
      });
    });

    it("refuses the right address holding the wrong asset", async () => {
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      expect(await matcher.match(claim({ tokenContract: USDT_ETHEREUM }))).toMatchObject({
        match: false,
        reasonCode: MATCH_REASONS.WALLET_NOT_ON_FILE,
      });
    });

    it("matches across corporate-suffix and casing differences", async () => {
      // The canonicaliser is what makes digest matching usable at all:
      // "MERIDIAN COMPONENTS PRIVATE LIMITED" and "Meridian Components Pvt Ltd"
      // must reduce to one string, or every legitimate payment fails.
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      const result = await matcher.match(
        claim({ claimedNameHmac: nameDigest("MERIDIAN COMPONENTS PRIVATE LIMITED")! }),
      );
      expect(result).toMatchObject({ match: true });
    });

    it("matches regardless of token order", async () => {
      // nameSimilarity compared SETS, so order never mattered. Canonicalisation
      // sorts precisely to preserve that; without the sort this would fail.
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      await expect(
        matcher.match(claim({ claimedNameHmac: nameDigest("Components Meridian Pvt Ltd")! })),
      ).resolves.toMatchObject({ match: true });
    });

    it("reports IDENTITY_MISMATCH when the name disagrees", async () => {
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      expect(
        await matcher.match(claim({ claimedNameHmac: nameDigest("Rakesh Traders")! })),
      ).toEqual({ match: false, reasonCode: MATCH_REASONS.IDENTITY_MISMATCH });
    });

    it("reports IDENTITY_MISMATCH when the PAN disagrees", async () => {
      // Deliberately the SAME reason code as a name mismatch. Reporting which
      // field failed would give a prober a second bit and let them hold the PAN
      // constant while varying the name to isolate it (D62).
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      expect(await matcher.match(claim({ claimedPanHmac: digest("ZZZZZ9999Z") }))).toEqual({
        match: false,
        reasonCode: MATCH_REASONS.IDENTITY_MISMATCH,
      });
    });

    it("requires BOTH name and PAN — neither alone is sufficient", async () => {
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));

      // Right PAN, wrong name: a shared or guessed number must not carry it.
      await expect(
        matcher.match(claim({ claimedNameHmac: nameDigest("Someone Else Ltd")! })),
      ).resolves.toMatchObject({ match: false });

      // Right name, wrong PAN: company names are not unique.
      await expect(
        matcher.match(claim({ claimedPanHmac: digest("QQQQQ0000Q") })),
      ).resolves.toMatchObject({ match: false });
    });

    it("treats a missing digest on the RECORD as a refusal, not a wildcard", async () => {
      // An unverified payee has no digest on file. If null matched anything,
      // "we have no data" would be indistinguishable from "the data agrees" —
      // the exact fail-open this product cannot afford.
      const noName = createMatcher(vendorLookupOf(payeeOnFile({ legalNameHmac: null })));
      await expect(noName.match(claim())).resolves.toEqual({
        match: false,
        reasonCode: MATCH_REASONS.IDENTITY_MISMATCH,
      });

      const noPan = createMatcher(vendorLookupOf(payeeOnFile({ panNumberHmac: null })));
      await expect(noPan.match(claim())).resolves.toEqual({
        match: false,
        reasonCode: MATCH_REASONS.IDENTITY_MISMATCH,
      });
    });

    it("never returns a score — digest matching is exact", async () => {
      // A fabricated 1.0/0 would invite a caller to build a threshold on it and
      // believe the threshold meant something.
      const matcher = createMatcher(vendorLookupOf(payeeOnFile()));
      const result = await matcher.match(claim());
      expect(result).not.toHaveProperty("score");
    });
  });
}
