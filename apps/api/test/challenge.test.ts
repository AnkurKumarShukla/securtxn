// P5 — the payee challenge triggers.
//
// Pure-function tests: no server, no database. Each case isolates ONE trigger
// by holding every other input at its quiet value, so a test that fails names
// the rule that broke.

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assessPayeeChallenge,
  CHALLENGE_TRIGGERS,
  MISMATCH_WINDOW_DAYS,
  SELFIE_CHECK_WINDOW_DAYS,
  WALLET_ROTATION_WINDOW_DAYS,
  type ChallengeInput,
} from "../src/modules/consent/challenge.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

/** A payee nothing is wrong with: known sender, small amount, fresh everything. */
function quiet(overrides: Partial<ChallengeInput> = {}): ChallengeInput {
  return {
    now: NOW,
    hasPriorSettledPayment: true,
    amount: new Prisma.Decimal("1000"),
    tierCeiling: new Prisma.Decimal("100000"),
    walletConfirmedAt: daysAgo(400),
    lastSelfieCheckAt: daysAgo(3),
    lastIdentityMismatchAt: null,
    ...overrides,
  };
}

describe("payee challenge (P5)", () => {
  it("does not challenge when nothing is unusual", () => {
    // The load-bearing case. If this ever fires, the risk engine has become
    // "always challenge" with extra steps, and the habituation it was designed
    // to avoid is back.
    expect(assessPayeeChallenge(quiet())).toEqual({ required: false, triggers: [] });
  });

  it("challenges the first payment between two parties", () => {
    const result = assessPayeeChallenge(quiet({ hasPriorSettledPayment: false }));
    expect(result.required).toBe(true);
    expect(result.triggers).toEqual([CHALLENGE_TRIGGERS.FIRST_PAYMENT_FROM_SENDER]);
  });

  it("challenges an amount above the tier ceiling but not one exactly at it", () => {
    const at = assessPayeeChallenge(
      quiet({ amount: new Prisma.Decimal("100000"), tierCeiling: new Prisma.Decimal("100000") }),
    );
    expect(at.triggers).not.toContain(CHALLENGE_TRIGGERS.ABOVE_TIER_CEILING);

    const above = assessPayeeChallenge(
      quiet({ amount: new Prisma.Decimal("100000.000000000000000001") }),
    );
    expect(above.triggers).toContain(CHALLENGE_TRIGGERS.ABOVE_TIER_CEILING);
  });

  it("treats a null ceiling as no ceiling, not as zero", () => {
    // A sentinel would make the highest tier the most challenged one.
    const result = assessPayeeChallenge(
      quiet({ tierCeiling: null, amount: new Prisma.Decimal("99999999") }),
    );
    expect(result).toEqual({ required: false, triggers: [] });
  });

  it("challenges while a wallet rotation is recent, and stops once it ages out", () => {
    const fresh = assessPayeeChallenge(
      quiet({ walletConfirmedAt: daysAgo(WALLET_ROTATION_WINDOW_DAYS - 1) }),
    );
    expect(fresh.triggers).toContain(CHALLENGE_TRIGGERS.WALLET_RECENTLY_ROTATED);

    const aged = assessPayeeChallenge(
      quiet({ walletConfirmedAt: daysAgo(WALLET_ROTATION_WINDOW_DAYS + 1) }),
    );
    expect(aged.triggers).not.toContain(CHALLENGE_TRIGGERS.WALLET_RECENTLY_ROTATED);
  });

  it("challenges a selfie check older than the World ID window", () => {
    const stale = assessPayeeChallenge(
      quiet({ lastSelfieCheckAt: daysAgo(SELFIE_CHECK_WINDOW_DAYS + 1) }),
    );
    expect(stale.triggers).toContain(CHALLENGE_TRIGGERS.SELFIE_CHECK_STALE);

    const inside = assessPayeeChallenge(
      quiet({ lastSelfieCheckAt: daysAgo(SELFIE_CHECK_WINDOW_DAYS - 1) }),
    );
    expect(inside.triggers).not.toContain(CHALLENGE_TRIGGERS.SELFIE_CHECK_STALE);
  });

  it("reports NOT_ENROLLED separately from a stale check", () => {
    // The two need different handling: stale is fixed by taking a selfie,
    // never-enrolled cannot be, so the caller must not loop the payee through
    // a check that has nothing to compare against.
    const result = assessPayeeChallenge(quiet({ lastSelfieCheckAt: null }));
    expect(result.triggers).toEqual([CHALLENGE_TRIGGERS.NOT_ENROLLED]);
    expect(result.triggers).not.toContain(CHALLENGE_TRIGGERS.SELFIE_CHECK_STALE);
  });

  it("keeps a recent mismatch raising the payee's risk, then lets it lapse", () => {
    const recent = assessPayeeChallenge(
      quiet({ lastIdentityMismatchAt: daysAgo(MISMATCH_WINDOW_DAYS - 1) }),
    );
    expect(recent.triggers).toContain(CHALLENGE_TRIGGERS.RECENT_IDENTITY_MISMATCH);

    const old = assessPayeeChallenge(
      quiet({ lastIdentityMismatchAt: daysAgo(MISMATCH_WINDOW_DAYS + 1) }),
    );
    expect(old.triggers).not.toContain(CHALLENGE_TRIGGERS.RECENT_IDENTITY_MISMATCH);
  });

  it("reports every trigger that fired, not just the first", () => {
    // A payee challenged for one routine reason looks different from one
    // challenged for four at once, and only the full list shows that.
    const result = assessPayeeChallenge(
      quiet({
        hasPriorSettledPayment: false,
        amount: new Prisma.Decimal("500000"),
        walletConfirmedAt: daysAgo(1),
        lastIdentityMismatchAt: daysAgo(2),
      }),
    );
    expect(result.required).toBe(true);
    expect(result.triggers).toEqual([
      CHALLENGE_TRIGGERS.FIRST_PAYMENT_FROM_SENDER,
      CHALLENGE_TRIGGERS.ABOVE_TIER_CEILING,
      CHALLENGE_TRIGGERS.WALLET_RECENTLY_ROTATED,
      CHALLENGE_TRIGGERS.RECENT_IDENTITY_MISMATCH,
    ]);
  });

  it("never treats a future timestamp as an aged-out one", () => {
    // Clock skew between the API and the database is normal. A wallet confirmed
    // "in the future" must still count as recent, or a few seconds of drift
    // would silently disable the rotation trigger.
    const result = assessPayeeChallenge(
      quiet({ walletConfirmedAt: new Date(NOW.getTime() + 30_000) }),
    );
    expect(result.triggers).toContain(CHALLENGE_TRIGGERS.WALLET_RECENTLY_ROTATED);
  });
});
