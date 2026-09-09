import { Prisma } from "@prisma/client";
import { FallbackVendorMatcher, MATCH_REASONS, nameSimilarity } from "@cp/cre-workflows";
import type { VerificationTier } from "@cp/shared-types";
import { describe, expect, it } from "vitest";
import { decide } from "../src/modules/decision/index.js";
import type { DecisionInput, TierThresholds } from "../src/modules/decision/types.js";
import { StubSanctionsScreener } from "../src/modules/sanctions/index.js";

// The engine is pure, so every branch is reachable by constructing an input —
// no database, no fixtures, no waiting for a stub to produce the case (D21).
const thresholds: TierThresholds = {
  maxAmountForTier(tier: VerificationTier) {
    const limits: Partial<Record<VerificationTier, string>> = {
      TIER0_UNVERIFIED: "0",
      TIER1_LIVENESS: "1000",
      TIER2_IDENTITY: "50000",
    };
    const limit = limits[tier];
    return limit === undefined ? null : new Prisma.Decimal(limit);
  },
};

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    vendorWallet: {
      status: "CONFIRMED",
      address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      network: "ethereum",
    },
    verificationTier: "TIER3_ADDRESS",
    matchResult: { match: true, score: 0.98, reasonCode: "MATCHED" },
    sanctionsHit: false,
    isNewOrChangedAddress: false,
    amount: new Prisma.Decimal("100"),
    ...overrides,
  };
}

describe("decision engine — hard blocks", () => {
  it("blocks on a sanctions hit", () => {
    const result = decide(input({ sanctionsHit: true }), thresholds);
    expect(result.decision).toBe("DO_NOT_SEND");
    expect(result.reasonCode).toBe("SANCTIONS_HIT");
  });

  it("blocks a wallet that is not CONFIRMED", () => {
    for (const status of ["PENDING_VERIFICATION", "REVOKED"] as const) {
      const result = decide(input({ vendorWallet: { ...input().vendorWallet, status } }), thresholds);
      expect(result.decision, status).toBe("DO_NOT_SEND");
      expect(result.reasonCode).toBe("WALLET_NOT_CONFIRMED");
    }
  });

  it("blocks TIER0 at any amount", () => {
    // A wallet signature proves key custody and nothing about who holds it.
    const result = decide(
      input({ verificationTier: "TIER0_UNVERIFIED", amount: new Prisma.Decimal("0.01") }),
      thresholds,
    );
    expect(result.decision).toBe("DO_NOT_SEND");
    expect(result.reasonCode).toBe("TIER_UNVERIFIED");
  });
});

describe("decision engine — precedence is policy", () => {
  it("reports the sanctions hit even when other checks also fail", () => {
    // The most severe finding is what lands in the evidence chain and gets read
    // back in a dispute. It must not be masked by an unrelated tier problem.
    const result = decide(
      input({
        sanctionsHit: true,
        vendorWallet: { ...input().vendorWallet, status: "REVOKED" },
        verificationTier: "TIER0_UNVERIFIED",
        matchResult: { match: false, score: 0.1, reasonCode: "NAME_BELOW_THRESHOLD" },
      }),
      thresholds,
    );
    expect(result.reasonCode).toBe("SANCTIONS_HIT");
  });

  it("prefers an unconfirmed wallet over a match failure", () => {
    const result = decide(
      input({
        vendorWallet: { ...input().vendorWallet, status: "PENDING_VERIFICATION" },
        matchResult: { match: false, score: 0.2, reasonCode: "NAME_BELOW_THRESHOLD" },
      }),
      thresholds,
    );
    expect(result.decision).toBe("DO_NOT_SEND");
    expect(result.reasonCode).toBe("WALLET_NOT_CONFIRMED");
  });
});

describe("decision engine — soft blocks", () => {
  it("sends a failed match to review rather than refusing outright", () => {
    // A name mismatch is often a typo or a trading name. It needs a person,
    // not a permanent refusal.
    const result = decide(
      input({ matchResult: { match: false, score: 0.4, reasonCode: "NAME_BELOW_THRESHOLD" } }),
      thresholds,
    );
    expect(result.decision).toBe("REVERIFY");
    expect(result.reasonCode).toBe("VENDOR_MATCH_FAILED");
  });

  it("reverifies an amount above the tier ceiling", () => {
    const result = decide(
      input({ verificationTier: "TIER1_LIVENESS", amount: new Prisma.Decimal("1000.01") }),
      thresholds,
    );
    expect(result.decision).toBe("REVERIFY");
    expect(result.reasonCode).toBe("AMOUNT_EXCEEDS_TIER_LIMIT");
    // The ceiling applied is recorded, so the call can be reproduced later.
    expect(result.tierLimitApplied).toBe("1000");
  });

  it("allows an amount exactly at the ceiling", () => {
    // The limit is inclusive. An off-by-one here rejects legitimate payments.
    const result = decide(
      input({ verificationTier: "TIER1_LIVENESS", amount: new Prisma.Decimal("1000") }),
      thresholds,
    );
    expect(result.decision).toBe("SAFE_TO_SEND");
  });

  it("applies no ceiling to a tier that has none", () => {
    const result = decide(
      input({ verificationTier: "TIER3_ADDRESS", amount: new Prisma.Decimal("9999999") }),
      thresholds,
    );
    expect(result.decision).toBe("SAFE_TO_SEND");
    expect(result.tierLimitApplied).toBeNull();
  });
});

describe("decision engine — proceed paths", () => {
  it("asks for a test amount on a first payment to an address", () => {
    const result = decide(input({ isNewOrChangedAddress: true }), thresholds);
    expect(result.decision).toBe("SEND_TEST_AMOUNT");
    expect(result.reasonCode).toBe("NEW_OR_CHANGED_ADDRESS");
  });

  it("clears a fully verified, previously paid address", () => {
    const result = decide(input(), thresholds);
    expect(result.decision).toBe("SAFE_TO_SEND");
    expect(result.reasonCode).toBe("ALL_CHECKS_PASSED");
  });

  it("is pure — the same input always yields the same decision", () => {
    const fixed = input();
    expect(decide(fixed, thresholds)).toEqual(decide(fixed, thresholds));
  });
});

describe("name similarity (shared by both matchers)", () => {
  it("matches the same company written two ways", () => {
    // A registry shouts; an invoice abbreviates. Same company.
    expect(
      nameSimilarity("MERIDIAN COMPONENTS PRIVATE LIMITED", "Meridian Components Pvt Ltd"),
    ).toBe(1);
  });

  it("ignores punctuation and ordering noise", () => {
    expect(nameSimilarity("Acme, Inc.", "ACME INC")).toBe(1);
  });

  it("separates different companies", () => {
    expect(nameSimilarity("Meridian Components", "Meridian Logistics")).toBeLessThan(0.85);
    expect(nameSimilarity("Acme Ltd", "Zenith Ltd")).toBe(0);
  });

  it("returns zero when only corporate suffixes remain", () => {
    // "Private Limited" vs "Ltd" must not read as a perfect match just because
    // both reduce to nothing.
    expect(nameSimilarity("Private Limited", "Ltd")).toBe(0);
  });
});

describe("FallbackVendorMatcher", () => {
  const vendor = {
    legalName: "Meridian Components Private Limited",
    wallets: [
      {
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        network: "ethereum",
        tokenContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
    ],
  };
  const matcher = new FallbackVendorMatcher({ minScore: 0.85, lookup: async () => vendor });

  const base = {
    vendorId: "v1",
    claimedLegalName: "Meridian Components Pvt Ltd",
    walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    network: "ethereum",
  };

  it("matches a known vendor, wallet and name", async () => {
    const result = await matcher.match(base);
    expect(result.match).toBe(true);
    expect(result.score).toBe(1);
    expect(result.reasonCode).toBe(MATCH_REASONS.MATCHED);
  });

  it("is case-insensitive about the address", async () => {
    const result = await matcher.match({ ...base, walletAddress: base.walletAddress.toLowerCase() });
    expect(result.match).toBe(true);
  });

  it("refuses an address the vendor never registered", async () => {
    // No name score can compensate: this is the misdirection the product exists
    // to prevent.
    const result = await matcher.match({
      ...base,
      walletAddress: "0x0000000000000000000000000000000000000001",
    });
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
  });

  it("refuses the right address on the wrong network", async () => {
    const result = await matcher.match({ ...base, network: "hedera" });
    expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
  });

  it("refuses the right address with the wrong token contract", async () => {
    const result = await matcher.match({
      ...base,
      tokenContract: "0x0000000000000000000000000000000000000002",
    });
    expect(result.reasonCode).toBe(MATCH_REASONS.WALLET_NOT_ON_FILE);
  });

  it("reports the score even when it falls below the threshold", async () => {
    // A human judging "typo" against "wrong company" needs the number.
    const result = await matcher.match({ ...base, claimedLegalName: "Meridian Logistics" });
    expect(result.match).toBe(false);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasonCode).toBe(MATCH_REASONS.NAME_BELOW_THRESHOLD);
  });

  it("reports a missing vendor rather than throwing", async () => {
    const missing = new FallbackVendorMatcher({ minScore: 0.85, lookup: async () => null });
    const result = await missing.match(base);
    expect(result.reasonCode).toBe(MATCH_REASONS.VENDOR_NOT_FOUND);
  });

  it("honours the configured threshold", async () => {
    // Risk appetite, not a constant: the same inputs decide differently.
    const strict = new FallbackVendorMatcher({ minScore: 0.99, lookup: async () => vendor });
    const loose = new FallbackVendorMatcher({ minScore: 0.3, lookup: async () => vendor });
    const claim = { ...base, claimedLegalName: "Meridian Components Group" };

    expect((await strict.match(claim)).match).toBe(false);
    expect((await loose.match(claim)).match).toBe(true);
  });
});

describe("StubSanctionsScreener", () => {
  it("always clears, and says so in its ref", async () => {
    const result = await new StubSanctionsScreener().screen({
      vendorId: "v1",
      legalName: "Anyone",
      walletAddress: "0x0000000000000000000000000000000000000001",
      network: "ethereum",
      country: "IN",
    });
    expect(result.sanctionsHit).toBe(false);
    // Honest about what it did NOT do — the ref must never look like a real check.
    expect(result.checkRef).toContain("stub");
  });
});
