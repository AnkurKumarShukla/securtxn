// P5 — does this payee have to prove they are still the human who enrolled?
//
// Pure, like the decision engine and for the same reason (D15): the rule that
// decides when a person is challenged should be readable and testable without a
// database behind it.
//
// WHY NOT ALWAYS CHALLENGE. A Selfie Check on every acceptance trains payees to
// treat it as a formality, and the one time it matters — a thief holding a
// stolen key — is the one time a habituated user clicks through fastest. It
// also fails honest payees who are travelling, on a borrowed device, or simply
// have no camera to hand, and the cost of that failure is a legitimate invoice
// going unpaid.
//
// What matters is that O7 enrolment happened. That is what makes the challenge
// AVAILABLE the moment something looks wrong; firing it constantly does not
// make it stronger.
//
// Spec: docs/payment-flow.md "Payee challenge triggers (P5)"

import type { DecimalLike } from "../decision/types.js";

/** Why a challenge fired. Recorded so a payee can be told what tripped it. */
export const CHALLENGE_TRIGGERS = {
  /** No settled payment has ever run between these two identities. */
  FIRST_PAYMENT_FROM_SENDER: "FIRST_PAYMENT_FROM_SENDER",
  /** Above what this payee's verification tier is trusted for. */
  ABOVE_TIER_CEILING: "ABOVE_TIER_CEILING",
  /**
   * The payee's payout address changed recently — the signature of an account
   * takeover, and the case a stolen key looks exactly like.
   */
  WALLET_RECENTLY_ROTATED: "WALLET_RECENTLY_ROTATED",
  /** Their last Selfie Check is older than the window World ID considers live. */
  SELFIE_CHECK_STALE: "SELFIE_CHECK_STALE",
  /** Someone recently claimed this payee's identity and got it wrong. */
  RECENT_IDENTITY_MISMATCH: "RECENT_IDENTITY_MISMATCH",
  /** The payee never enrolled, so no nullifier exists to compare against. */
  NOT_ENROLLED: "NOT_ENROLLED",
} as const;

export type ChallengeTrigger =
  (typeof CHALLENGE_TRIGGERS)[keyof typeof CHALLENGE_TRIGGERS];

/**
 * The window World ID's Selfie Check itself treats as current. Beyond it a
 * stored nullifier still identifies the same human, but says nothing about
 * whether that human is still the one holding the account.
 */
export const SELFIE_CHECK_WINDOW_DAYS = 90;

/** How long after a payout address changes the payee stays under suspicion. */
export const WALLET_ROTATION_WINDOW_DAYS = 7;

/** How long a failed claim against this payee keeps raising their risk. */
export const MISMATCH_WINDOW_DAYS = 30;

export type ChallengeInput = {
  /** Now, injected rather than read, so the windows are testable. */
  now: Date;
  /** Has this payer ever completed a payment to this payee before? */
  hasPriorSettledPayment: boolean;
  amount: DecimalLike;
  /** The payee's tier ceiling, or null when their tier has none. */
  tierCeiling: DecimalLike | null;
  /** When the payee's CURRENT payout wallet was confirmed. */
  walletConfirmedAt: Date | null;
  /**
   * The payee's most recent World ID verification, of any purpose.
   *
   * Null means they never enrolled: that is a challenge trigger, but the caller
   * must treat the resulting requirement as unsatisfiable and route it to a
   * human rather than looping the payee through a check they cannot pass.
   */
  lastSelfieCheckAt: Date | null;
  /** The last time a match against this payee failed, if ever. */
  lastIdentityMismatchAt: Date | null;
};

export type ChallengeAssessment = {
  required: boolean;
  triggers: ChallengeTrigger[];
};

const DAY_MS = 86_400_000;

function within(now: Date, then: Date | null, days: number): boolean {
  if (!then) return false;
  return now.getTime() - then.getTime() <= days * DAY_MS;
}

/**
 * Every trigger that fired, not just the first.
 *
 * Short-circuiting would be cheaper and would lose the reason a payee is
 * repeatedly challenged: "first payment" alone is routine, while "first payment
 * AND the wallet rotated on Tuesday AND someone got their PAN wrong last week"
 * is a pattern worth showing a human.
 */
export function assessPayeeChallenge(input: ChallengeInput): ChallengeAssessment {
  const triggers: ChallengeTrigger[] = [];

  if (!input.hasPriorSettledPayment) {
    triggers.push(CHALLENGE_TRIGGERS.FIRST_PAYMENT_FROM_SENDER);
  }

  // Strictly above. A payment exactly at the ceiling is within what the tier
  // was verified for; making the boundary itself suspicious would mean the
  // documented limit is not the real limit.
  if (input.tierCeiling !== null && input.amount.gt(input.tierCeiling)) {
    triggers.push(CHALLENGE_TRIGGERS.ABOVE_TIER_CEILING);
  }

  if (within(input.now, input.walletConfirmedAt, WALLET_ROTATION_WINDOW_DAYS)) {
    triggers.push(CHALLENGE_TRIGGERS.WALLET_RECENTLY_ROTATED);
  }

  if (input.lastSelfieCheckAt === null) {
    triggers.push(CHALLENGE_TRIGGERS.NOT_ENROLLED);
  } else if (!within(input.now, input.lastSelfieCheckAt, SELFIE_CHECK_WINDOW_DAYS)) {
    triggers.push(CHALLENGE_TRIGGERS.SELFIE_CHECK_STALE);
  }

  if (within(input.now, input.lastIdentityMismatchAt, MISMATCH_WINDOW_DAYS)) {
    triggers.push(CHALLENGE_TRIGGERS.RECENT_IDENTITY_MISMATCH);
  }

  return { required: triggers.length > 0, triggers };
}
