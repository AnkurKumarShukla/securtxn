import { Prisma } from "@prisma/client";
import { nameSimilarity } from "@cp/cre-workflows";
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
    matchResult: { match: true, reasonCode: "MATCHED" },
    sanctionsHit: false,
    isDuplicate: false,
    onChainKycGranted: true,
    isNewOrChangedAddress: false,
    amount: new Prisma.Decimal("100"),
    ...overrides,
  };
}

describe("decision engine — the on-chain gate (O8)", () => {
  it("sends a payee the token will not accept back for reverification", () => {
    // The chain's refusal, not ours. Attempting the transfer anyway reverts,
    // so surfacing it here turns a failed transaction into an answer.
    const result = decide(input({ onChainKycGranted: false }), thresholds);
    expect(result.decision).toBe("REVERIFY");
    expect(result.reasonCode).toBe("ONCHAIN_KYC_NOT_GRANTED");
  });

  it("is outranked by every hard block", () => {
    // A sanctioned payee whose grant is also missing must read as sanctioned:
    // the most severe finding is what lands in the evidence chain.
    expect(
      decide(input({ onChainKycGranted: false, sanctionsHit: true }), thresholds).reasonCode,
    ).toBe("SANCTIONS_HIT");
    expect(
      decide(input({ onChainKycGranted: false, isDuplicate: true }), thresholds).reasonCode,
    ).toBe("DUPLICATE_PAYMENT");
  });

  it("is reported ahead of an identity mismatch", () => {
    // A payee the token rejects cannot fix that by correcting a name, so the
    // actionable fault is the grant.
    const result = decide(
      input({
        onChainKycGranted: false,
        matchResult: { match: false, reasonCode: "IDENTITY_MISMATCH" },
      }),
      thresholds,
    );
    expect(result.reasonCode).toBe("ONCHAIN_KYC_NOT_GRANTED");
  });
});

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
        matchResult: { match: false, reasonCode: "NAME_BELOW_THRESHOLD" },
      }),
      thresholds,
    );
    expect(result.reasonCode).toBe("SANCTIONS_HIT");
  });

  it("prefers an unconfirmed wallet over a match failure", () => {
    const result = decide(
      input({
        vendorWallet: { ...input().vendorWallet, status: "PENDING_VERIFICATION" },
        matchResult: { match: false, reasonCode: "NAME_BELOW_THRESHOLD" },
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
      input({ matchResult: { match: false, reasonCode: "NAME_BELOW_THRESHOLD" } }),
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

// FallbackVendorMatcher's behaviour is NOT retested here.
//
// It lives in packages/cre-workflows/test/vendorMatcher.contract.ts, which both
// implementations run against the same assertions (D09). A second copy in this
// file would be free to drift from the CRE path, which is exactly the failure
// the shared contract exists to prevent — and since D62 the rule compares
// digests, so a duplicate here would also need its own hashing stand-in.

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
