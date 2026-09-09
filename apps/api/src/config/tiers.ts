// Tier ceilings: the largest payment each verification tier may receive.
//
// These are risk appetite, not physics. Different customers will set them
// differently, so they come from config and never appear as literals in the
// decision engine (D08).
//
// Spec: docs/architecture.md §4.1

import { Prisma } from "@prisma/client";
import type { VerificationTier } from "@cp/shared-types";
import type { Config } from "./index.js";
import type { DecimalLike, TierThresholds } from "../modules/decision/types.js";

/**
 * Builds the ceiling lookup from validated config.
 *
 * A tier absent from the map has no ceiling — that is how TIER3_ADDRESS, the
 * strongest tier, is expressed. Returning `null` rather than a very large
 * number keeps "unlimited" honest: a sentinel maximum would eventually be
 * compared against and silently become a real limit.
 */
export function createTierThresholds(config: Config): TierThresholds {
  const limits = new Map<VerificationTier, Prisma.Decimal>();

  for (const [tier, amount] of Object.entries(config.TIER_AMOUNT_LIMITS)) {
    if (amount !== undefined) {
      limits.set(tier as VerificationTier, new Prisma.Decimal(amount));
    }
  }

  return {
    maxAmountForTier(tier: VerificationTier): DecimalLike | null {
      return limits.get(tier) ?? null;
    },
  };
}
