import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import * as SharedEnums from "@cp/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

// Runs against the local Postgres container with migrations applied and the
// seed loaded: `pnpm --filter @cp/api db:migrate && pnpm --filter @cp/api seed`.
const config = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });

const SEED_VENDOR_ID = "00000000-0000-4000-8000-000000000001";
const SEED_WALLET_ID = "00000000-0000-4000-8000-000000000002";
const GENESIS = "0".repeat(64);

/** Rows created by these tests, removed in afterAll. */
const created = { evidenceIds: [] as string[], paymentIds: [] as string[] };

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  if (created.evidenceIds.length) {
    await prisma.evidenceRecord.deleteMany({ where: { id: { in: created.evidenceIds } } });
  }
  if (created.paymentIds.length) {
    await prisma.paymentRequest.deleteMany({ where: { id: { in: created.paymentIds } } });
  }
  await prisma.$disconnect();
});

describe("enum parity with schema.prisma", () => {
  // shared-types duplicates the Prisma enums so web and approval-bridge (which
  // have no Prisma client) and the pure decision engine can use them. Duplication
  // is only safe if it is checked.
  const schema = readFileSync(join(import.meta.dirname, "..", "prisma", "schema.prisma"), "utf8");

  const prismaEnums = new Map<string, string[]>();
  for (const match of schema.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const [, name = "", body = ""] = match;
    const values = body
      .split("\n")
      // No `$` anchor: schema.prisma has CRLF line endings, and `.` never
      // matches `\r` (a line terminator in JS regex) — with `$`, a line whose
      // comment is followed by `\r` has no valid match position at all, so
      // .replace() silently no-ops and the full comment survives parsing.
      .map((line) => line.replace(/\/\/.*/, "").trim())
      .filter(Boolean);
    prismaEnums.set(name, values);
  }

  /**
   * Enums that are storage detail and deliberately NOT part of the shared wire
   * vocabulary — web and approval-bridge have no reason to know them.
   *
   * Listing one here is a visible edit, which is the point: the parity
   * guarantee stays meaningful because opting out is explicit rather than
   * silent.
   */
  const INTERNAL_ONLY = new Set([
    "BlobKind",
    // The lifecycle of one CRE invocation (D48). It never crosses the API
    // boundary: the callback endpoint answers RECORDED/ALREADY_RECORDED, and
    // callers of the matcher get a verdict or an exception — never this.
    "VendorMatchRequestStatus",
    // Enrollment vs re-verification of a World ID proof (D49). Internal to the
    // verification module; callers get a verdict or an exception, never this.
    "WorldIdPurpose",
  ]);

  it("finds every enum in the schema and accounts for each one", () => {
    expect(prismaEnums.size).toBeGreaterThanOrEqual(10);
    for (const name of prismaEnums.keys()) {
      const mirrored = (SharedEnums as Record<string, unknown>)[name] !== undefined;
      expect(
        mirrored || INTERNAL_ONLY.has(name),
        `${name} is neither mirrored in @cp/shared-types nor listed as internal-only`,
      ).toBe(true);
    }
  });

  it.each([...prismaEnums.keys()].filter((n) => !INTERNAL_ONLY.has(n)))(
    "%s matches the shared-types mirror",
    (name) => {
      const mirror = (SharedEnums as Record<string, unknown>)[name] as
        | { options: readonly string[] }
        | undefined;

      expect(mirror, `@cp/shared-types is missing an enum named ${name}`).toBeDefined();
      expect(mirror?.options).toEqual(prismaEnums.get(name));
    },
  );
});

describe("seeded chain", () => {
  it("links vendor -> wallet -> payment without foreign key errors", async () => {
    const vendor = await prisma.vendor.findUnique({
      where: { id: SEED_VENDOR_ID },
      include: { wallets: true, payments: true },
    });

    expect(vendor).not.toBeNull();
    expect(vendor?.kybStatus).toBe("VERIFIED");
    expect(vendor?.verificationTier).toBe("TIER3_ADDRESS");
    expect(vendor?.wallets).toHaveLength(1);
    expect(vendor?.wallets[0]?.status).toBe("CONFIRMED");
    expect(vendor?.payments).toHaveLength(1);
  });

  it("confirms the wallet through the registry contact, not a submitted one (D05)", async () => {
    const wallet = await prisma.vendorWallet.findUnique({ where: { id: SEED_WALLET_ID } });
    const vendor = await prisma.vendor.findUnique({ where: { id: SEED_VENDOR_ID } });

    // This is the invariant callback-confirm will enforce server-side in A4.
    expect(wallet?.callbackChannelUsed).toBe(vendor?.registryVerifiedContact);
    expect(wallet?.callbackChannelUsed).toBeTruthy();
  });

  it("binds wallet and vendor with the same onboarding nonce (D03)", async () => {
    const wallet = await prisma.vendorWallet.findUnique({ where: { id: SEED_WALLET_ID } });
    const vendor = await prisma.vendor.findUnique({ where: { id: SEED_VENDOR_ID } });

    expect(wallet?.controlProofNonce).toBe(vendor?.onboardingSessionNonce);
  });
});

describe("integrity constraints", () => {
  /**
   * Creates a payment owned by this suite.
   *
   * These tests previously operated on the seeded payment, and the
   * delete-restriction test then destroyed seed data whenever its precondition
   * did not hold. A test that can delete the fixtures it depends on is a test
   * that fails mysteriously on the next run.
   */
  async function ownPayment(): Promise<string> {
    const payment = await prisma.paymentRequest.create({
      data: {
        vendorId: SEED_VENDOR_ID,
        vendorWalletId: SEED_WALLET_ID,
        invoiceRef: `INV-CONSTRAINT-${Date.now()}`,
        amount: "1",
        token: "USDC",
        network: "ethereum",
        senderContextCommitment: "0x" + "55".repeat(32),
      },
    });
    created.paymentIds.push(payment.id);
    return payment.id;
  }

  it("rejects a second wallet at the same version for one vendor", async () => {
    // Two v1 wallets would make the rotation history ambiguous, and with it the
    // question "which address was CONFIRMED on date X" (D01).
    await expect(
      prisma.vendorWallet.create({
        data: {
          vendorId: SEED_VENDOR_ID,
          address: "0xdeadbeef00000000000000000000000000000000",
          network: "ethereum",
          version: 1,
        },
      }),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it("rejects a forked evidence chain", async () => {
    // Two records claiming the same predecessor is a fork: the chain would have
    // two valid readings. The database refuses it rather than leaving it to be
    // discovered during verification (D07).
    const paymentId = await ownPayment();
    const first = await prisma.evidenceRecord.create({
      data: {
        paymentRequestId: paymentId,
        eventType: "decision",
        payload: { eventType: "decision", note: "fork-guard fixture" },
        payloadHash: "a".repeat(64),
        previousRecordHash: GENESIS,
      },
    });
    created.evidenceIds.push(first.id);

    await expect(
      prisma.evidenceRecord.create({
        data: {
          paymentRequestId: paymentId,
          eventType: "decision",
          payload: { eventType: "decision", note: "second claim on the same predecessor" },
          payloadHash: "b".repeat(64),
          previousRecordHash: GENESIS,
        },
      }),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it("refuses to delete a payment that has evidence attached", async () => {
    // onDelete: Restrict. An audit trail that disappears with its subject is
    // not an audit trail.
    const paymentId = await ownPayment();
    const record = await prisma.evidenceRecord.create({
      data: {
        paymentRequestId: paymentId,
        eventType: "decision",
        payload: { eventType: "decision", note: "delete-restriction fixture" },
        payloadHash: "e".repeat(64),
        previousRecordHash: GENESIS,
      },
    });
    created.evidenceIds.push(record.id);

    await expect(prisma.paymentRequest.delete({ where: { id: paymentId } })).rejects.toThrow();
  });
});

describe("money precision", () => {
  it("round-trips 18 decimal places without rounding", async () => {
    // ERC-20 stablecoins carry 18 decimals. Silent rounding here is a wrong
    // amount sent irreversibly.
    const smallest = "0.000000000000000001";
    const payment = await prisma.paymentRequest.create({
      data: {
        vendorId: SEED_VENDOR_ID,
        vendorWalletId: SEED_WALLET_ID,
        invoiceRef: "INV-PRECISION-TEST",
        amount: smallest,
        token: "USDC",
        network: "ethereum",
        senderContextCommitment: "0x" + "44".repeat(32),
      },
    });
    created.paymentIds.push(payment.id);

    const readBack = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: payment.id } });
    expect(readBack.amount.toFixed(18)).toBe(smallest);
  });
});
