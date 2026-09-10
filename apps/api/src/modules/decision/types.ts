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

/**
 * No score since D62. The match compares HMAC digests inside an enclave with no
 * crypto, so it is exact — a fabricated 1.0/0 would invite a threshold that
 * means nothing.
 */
export type MatchResult = { match: boolean; reasonCode: string };

export type DecisionInput = {
  vendorWallet: WalletSnapshot;
  verificationTier: VerificationTier;
  matchResult: MatchResult;
  sanctionsHit: boolean;
  /**
   * An earlier payment already settled for this invoice.
   *
   * A hard block: paying the same invoice twice is money gone for the same
   * reason as a misdirect, and the second one is usually a process error rather
   * than fraud — which is exactly why nothing downstream catches it.
   */
  isDuplicate: boolean;
  isNewOrChangedAddress: boolean;

  /**
   * Whether the ATS token accepts this address (O8, Hedera).
   *
   * TRUE WHEN THERE IS NO CHAIN TO ASK. The caller passes true when the
   * compliance gateway is a mock or no security is configured, because the
   * mock answers NOT_GRANTED for every address that never went through
   * `/grant-kyc` — gating on an in-memory map would block every payment while
   * proving nothing. A control that is theatre in the common case is worse
   * than no control, because it reads as one.
   */
  onChainKycGranted: boolean;
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
