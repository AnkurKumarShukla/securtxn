// Decision engine inputs. Kept separate from decide.ts, and free of Prisma
// imports, so the pure function has no path to a database or a network (D15).
// Spec: docs/architecture.md §4.1

import type { PaymentDecision, VerificationTier, WalletStatus } from "@cp/shared-types";

/**
 * Structural type satisfied by Prisma's `Decimal` (decimal.js) without importing
 * it. Keeps money comparisons exact while leaving this module ORM-free.
 */
export interface DecimalLike {
  gt(other: DecimalLike | string | number): boolean;
  toString(): string;
}

/** Only the wallet fields the decision actually reads. */
export type WalletSnapshot = {
  status: WalletStatus;
  address: string;
  network: string;
};

export type MatchResult = { match: boolean; score: number; reasonCode: string };

export type DecisionInput = {
  vendorWallet: WalletSnapshot;
  verificationTier: VerificationTier;
  matchResult: MatchResult;
  sanctionsHit: boolean;
  isNewOrChangedAddress: boolean;
  amount: DecimalLike;
};

/** Per-customer risk appetite. Loaded from config/tiers.ts, never hardcoded (D08). */
export interface TierThresholds {
  /**
   * The ceiling for a tier, or null when that tier has none.
   *
   * Null rather than a sentinel maximum: a very large number would eventually
   * be compared against and quietly become a real limit.
   */
  maxAmountForTier(tier: VerificationTier): DecimalLike | null;
}

export type { PaymentDecision };
