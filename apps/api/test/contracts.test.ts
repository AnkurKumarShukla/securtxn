import {
  AmountString,
  CreatePaymentRequest,
  CreateVendorRequest,
  EvidencePayload,
  EvmAddress,
  GENESIS_PREVIOUS_HASH,
  PendingProposal,
  UpdateExceptionRequest,
  VendorSummary,
} from "@cp/shared-types";
import { describe, expect, it } from "vitest";
import { EnvSchema } from "../src/config/index.js";
import { createTierThresholds } from "../src/config/tiers.js";
import type { Config } from "../src/config/index.js";

describe("money is never a float", () => {
  it("accepts up to 18 decimal places", () => {
    expect(AmountString.safeParse("0.000000000000000001").success).toBe(true);
    expect(AmountString.safeParse("12500.5").success).toBe(true);
  });

  it("rejects more precision than the column can hold", () => {
    // Decimal(38,18) — a 19th decimal would be silently truncated on write (D25).
    expect(AmountString.safeParse("0.0000000000000000001").success).toBe(false);
  });

  it("rejects zero, negatives and non-numeric text", () => {
    for (const bad of ["0", "0.00", "-5", "1e18", "abc", ""]) {
      expect(AmountString.safeParse(bad).success, `${bad} should be rejected`).toBe(false);
    }
  });
});

describe("address validation", () => {
  it("requires a 0x-prefixed 20-byte address", () => {
    expect(EvmAddress.safeParse("0x70997970C51812dc3A010C7d01b50e0d17dc79C8").success).toBe(true);
    // One character short — the class of typo that sends money nowhere.
    expect(EvmAddress.safeParse("0x70997970C51812dc3A010C7d01b50e0d17dc79C").success).toBe(false);
    expect(EvmAddress.safeParse("70997970C51812dc3A010C7d01b50e0d17dc79C8").success).toBe(false);
  });
});

describe("vendor creation discriminates on payee type", () => {
  it("requires a legal name for an individual", () => {
    expect(
      CreateVendorRequest.safeParse({
        payeeType: "INDIVIDUAL",
        legalFirstName: "Asha",
        legalLastName: "Rao",
        country: "IN",
      }).success,
    ).toBe(true);

    expect(
      CreateVendorRequest.safeParse({ payeeType: "INDIVIDUAL", country: "IN" }).success,
    ).toBe(false);
  });

  it("requires an entity name for a business", () => {
    expect(
      CreateVendorRequest.safeParse({
        payeeType: "BUSINESS",
        legalEntityName: "Meridian Components Pvt Ltd",
        country: "IN",
      }).success,
    ).toBe(true);

    // An individual's name fields do not satisfy a business payee.
    expect(
      CreateVendorRequest.safeParse({
        payeeType: "BUSINESS",
        legalFirstName: "Asha",
        country: "IN",
      }).success,
    ).toBe(false);
  });

  it("rejects a country that is not ISO alpha-2", () => {
    expect(
      CreateVendorRequest.safeParse({
        payeeType: "BUSINESS",
        legalEntityName: "X",
        country: "India",
      }).success,
    ).toBe(false);
  });
});

describe("vendor summary carries no raw PII (D06)", () => {
  it("strips unknown fields rather than passing them through", () => {
    const parsed = VendorSummary.parse({
      id: "00000000-0000-4000-8000-000000000001",
      payeeType: "BUSINESS",
      displayName: "Meridian Components Pvt Ltd",
      country: "IN",
      kybStatus: "VERIFIED",
      verificationTier: "TIER3_ADDRESS",
      aadhaarLast4: "1234",
      xmlSignatureVerified: true,
      crossDocConsistent: true,
      aadhaarKycTtl: "2027-09-03T04:10:04.000Z",
      createdAt: "2026-09-08T00:00:00.000Z",
      // Anything that leaked into the projection must not survive parsing.
      dobEncrypted: "should-not-appear",
      panNumberHmac: "should-not-appear",
      verifiedAddressEncrypted: { street: "should-not-appear" },
    });

    expect(parsed).not.toHaveProperty("dobEncrypted");
    expect(parsed).not.toHaveProperty("panNumberHmac");
    expect(parsed).not.toHaveProperty("verifiedAddressEncrypted");
    expect(parsed.aadhaarLast4).toBe("1234");
  });
});

describe("evidence payloads", () => {
  const timestamp = "2026-09-09T10:00:00.000Z";
  const paymentRequestId = "00000000-0000-4000-8000-000000000003";

  it("validates a decision payload against its own shape", () => {
    const result = EvidencePayload.safeParse({
      eventType: "decision",
      paymentRequestId,
      timestamp,
      data: {
        decision: "SAFE_TO_SEND",
        reasonCode: "ALL_CHECKS_PASSED",
        matchScore: 0.97,
        tierLimitApplied: "50000",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload whose data belongs to a different event type", () => {
    // The discriminated union is what stops an arbitrary object — and the PII
    // in it — being written into the chain (design principle 2).
    const result = EvidencePayload.safeParse({
      eventType: "decision",
      paymentRequestId,
      timestamp,
      data: { txHash: "0xabc", network: "ethereum" },
    });
    expect(result.success).toBe(false);
  });

  it("strips fields the schema does not declare", () => {
    const parsed = EvidencePayload.parse({
      eventType: "ack",
      paymentRequestId,
      timestamp,
      data: {
        recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        recipientCommitment: "0x" + "33".repeat(32),
        legalName: "should-not-be-anchored",
      },
    });
    expect(parsed.data).not.toHaveProperty("legalName");
  });

  it("defines genesis as 64 zeroes", () => {
    expect(GENESIS_PREVIOUS_HASH).toHaveLength(64);
    expect(GENESIS_PREVIOUS_HASH).toMatch(/^0+$/);
  });
});

describe("bridge contract", () => {
  it("accepts a well-formed proposal", () => {
    expect(
      PendingProposal.safeParse({
        id: "00000000-0000-4000-8000-000000000004",
        paymentRequestId: "00000000-0000-4000-8000-000000000003",
        vendorName: "Meridian Components Pvt Ltd",
        invoiceRef: "INV-2026-0912",
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        network: "ethereum",
        amount: "12500.5",
        token: "USDC",
        decision: "SAFE_TO_SEND",
        decisionReasonCode: "ALL_CHECKS_PASSED",
        isNewOrChangedAddress: false,
        proposedAt: "2026-09-09T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("exception updates", () => {
  it("rejects an empty patch", () => {
    expect(UpdateExceptionRequest.safeParse({}).success).toBe(false);
  });

  it("accepts a status change alone", () => {
    expect(UpdateExceptionRequest.safeParse({ status: "IN_RECOVERY" }).success).toBe(true);
  });
});

describe("payment creation", () => {
  it("requires an explicit wallet version, not just a vendor", () => {
    // A rotation between decision and send would otherwise redirect the money.
    const withoutWallet = {
      vendorId: "00000000-0000-4000-8000-000000000001",
      invoiceRef: "INV-1",
      amount: "100",
      token: "USDC",
      network: "ethereum",
    };
    expect(CreatePaymentRequest.safeParse(withoutWallet).success).toBe(false);
  });
});

describe("tier thresholds (D08)", () => {
  const buildConfig = (limits?: string): Config => {
    const parsed = EnvSchema.parse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      HMAC_PEPPER: "a".repeat(64),
      PII_ENCRYPTION_KEY: "b".repeat(64),
      JWT_AGENT_SECRET: "1".repeat(32),
      JWT_APPROVER_SECRET: "2".repeat(32),
      JWT_BRIDGE_SECRET: "3".repeat(32),
      ...(limits === undefined ? {} : { TIER_AMOUNT_LIMITS: limits }),
    });
    return { ...parsed, isProduction: false, corsOrigins: [] };
  };

  it("applies the configured ceiling per tier", () => {
    const thresholds = createTierThresholds(buildConfig());
    expect(thresholds.maxAmountForTier("TIER1_LIVENESS")?.toString()).toBe("1000");
    expect(thresholds.maxAmountForTier("TIER2_IDENTITY")?.toString()).toBe("50000");
    expect(thresholds.maxAmountForTier("TIER0_UNVERIFIED")?.toString()).toBe("0");
  });

  it("treats an omitted tier as having no ceiling", () => {
    const thresholds = createTierThresholds(buildConfig());
    expect(thresholds.maxAmountForTier("TIER3_ADDRESS")).toBeNull();
  });

  it("reads limits from config rather than hardcoding them", () => {
    const thresholds = createTierThresholds(buildConfig('{"TIER1_LIVENESS":"250.5"}'));
    expect(thresholds.maxAmountForTier("TIER1_LIVENESS")?.toString()).toBe("250.5");
    expect(thresholds.maxAmountForTier("TIER2_IDENTITY")).toBeNull();
  });

  it("refuses malformed limits at config load, not at first use (D22)", () => {
    expect(EnvSchema.safeParse({ ...baseEnv(), TIER_AMOUNT_LIMITS: "not json" }).success).toBe(false);
    expect(
      EnvSchema.safeParse({ ...baseEnv(), TIER_AMOUNT_LIMITS: '{"NOT_A_TIER":"100"}' }).success,
    ).toBe(false);
    expect(
      EnvSchema.safeParse({ ...baseEnv(), TIER_AMOUNT_LIMITS: '{"TIER1_LIVENESS":"ten"}' }).success,
    ).toBe(false);
  });

  function baseEnv(): Record<string, string> {
    return {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      HMAC_PEPPER: "a".repeat(64),
      PII_ENCRYPTION_KEY: "b".repeat(64),
      JWT_AGENT_SECRET: "1".repeat(32),
      JWT_APPROVER_SECRET: "2".repeat(32),
      JWT_BRIDGE_SECRET: "3".repeat(32),
    };
  }
});
