// The decision state machine.
//
// One pure function, not if/else scattered across the payment routes. Every
// branch is auditable, and the whole thing is testable without a database
// (D08, D15).
//
// ORDER IS POLICY. The checks run hard-block first, then soft, and the first
// match wins. A sanctions hit must not be masked by an unrelated tier problem —
// the most severe finding is the one recorded in the evidence chain and read
// back during a dispute.
//
// Spec: docs/architecture.md §4.1

import type { DecisionReasonCode } from "@cp/shared-types";
import type { DecisionInput, PaymentDecision, TierThresholds } from "./types.js";

export type Decision = {
  decision: PaymentDecision;
  reasonCode: DecisionReasonCode;
  /** The ceiling applied, when one was. Recorded so a reader can reproduce the call. */
  tierLimitApplied: string | null;
};

export function decide(input: DecisionInput, cfg: TierThresholds): Decision {
  // --- hard blocks: no amount of other evidence overrides these -------------

  if (input.sanctionsHit) {
    return { decision: "DO_NOT_SEND", reasonCode: "SANCTIONS_HIT", tierLimitApplied: null };
  }

  // Covers both PENDING_VERIFICATION and REVOKED. A wallet that has not passed
  // all three gates (D34), or has been revoked since, is not a payout address.
  if (input.vendorWallet.status !== "CONFIRMED") {
    return { decision: "DO_NOT_SEND", reasonCode: "WALLET_NOT_CONFIRMED", tierLimitApplied: null };
  }

  // A wallet signature alone proves key custody and nothing about who holds it.
  // TIER0 is never eligible, at any amount.
  if (input.verificationTier === "TIER0_UNVERIFIED") {
    return { decision: "DO_NOT_SEND", reasonCode: "TIER_UNVERIFIED", tierLimitApplied: null };
  }

  // --- soft blocks: send this to a human, do not send the money -------------

  if (!input.matchResult.match) {
    // REVERIFY, not DO_NOT_SEND: a name mismatch is frequently a typo or a
    // trading-name difference. It needs a person, not a permanent refusal.
    return { decision: "REVERIFY", reasonCode: "VENDOR_MATCH_FAILED", tierLimitApplied: null };
  }

  // Null means this tier has no ceiling — never a sentinel maximum, which would
  // eventually be compared against and quietly become a real limit.
  const limit = cfg.maxAmountForTier(input.verificationTier);
  if (limit !== null && input.amount.gt(limit)) {
    return {
      decision: "REVERIFY",
      reasonCode: "AMOUNT_EXCEEDS_TIER_LIMIT",
      tierLimitApplied: limit.toString(),
    };
  }

  // --- proceed, with a first-payment safeguard ------------------------------

  if (input.isNewOrChangedAddress) {
    // The highest-risk moment in the whole flow: everything checks out, and
    // this address has never been paid before. Send a token amount and confirm
    // receipt before the full value moves.
    return {
      decision: "SEND_TEST_AMOUNT",
      reasonCode: "NEW_OR_CHANGED_ADDRESS",
      tierLimitApplied: limit?.toString() ?? null,
    };
  }

  return {
    decision: "SAFE_TO_SEND",
    reasonCode: "ALL_CHECKS_PASSED",
    tierLimitApplied: limit?.toString() ?? null,
  };
}
