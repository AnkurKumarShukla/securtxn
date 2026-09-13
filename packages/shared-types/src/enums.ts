// Mirrors the Prisma enums (docs/architecture.md §3). Duplicated deliberately:
// web and approval-bridge have no Prisma client, and the pure decision engine
// must not import an ORM (D15). A test in A1 asserts these stay in sync with
// schema.prisma.

import { z } from "zod";

export const WalletStatus = z.enum([
  "PENDING_VERIFICATION",
  "CONFIRMED",
  "REVOKED",
]);
export type WalletStatus = z.infer<typeof WalletStatus>;

export const PaymentDecision = z.enum([
  "SAFE_TO_SEND",
  "DO_NOT_SEND",
  "REVERIFY",
  "SEND_TEST_AMOUNT",
]);
export type PaymentDecision = z.infer<typeof PaymentDecision>;

export const PaymentStatus = z.enum([
  "DRAFT",
  "AWAITING_PAYEE_CONSENT",
  "DECISION_PENDING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SENT",
  "CONFIRMED_ON_CHAIN",
  "EXCEPTION",
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const ExceptionType = z.enum([
  "OVERPAY",
  "MISDIRECT",
  "DUPLICATE",
  "WRONG_ASSET",
  "DISPUTE",
]);
export type ExceptionType = z.infer<typeof ExceptionType>;

export const ExceptionStatus = z.enum([
  "OPEN",
  "IN_RECOVERY",
  "RESOLVED",
  "WRITTEN_OFF",
]);
export type ExceptionStatus = z.infer<typeof ExceptionStatus>;

export const PayeeType = z.enum(["INDIVIDUAL", "BUSINESS"]);
export type PayeeType = z.infer<typeof PayeeType>;

/** Ordered weakest → strongest. TIER0 is never eligible for SAFE_TO_SEND. */
export const VerificationTier = z.enum([
  "TIER0_UNVERIFIED",
  "TIER1_LIVENESS",
  "TIER2_IDENTITY",
  "TIER3_ADDRESS",
]);
export type VerificationTier = z.infer<typeof VerificationTier>;

// Closed vocabularies that §3 typed as String. Promoted to enums in
// schema.prisma because they gate risk decisions (D25).

export const KybStatus = z.enum(["PENDING", "VERIFIED", "REJECTED"]);
export type KybStatus = z.infer<typeof KybStatus>;

/** VOIP is not usable for a dispute callout and must be treated as weak. */
export const PhoneLineType = z.enum(["MOBILE", "LANDLINE", "VOIP"]);
export type PhoneLineType = z.infer<typeof PhoneLineType>;

/** Ordered strongest → weakest. */
export const AddressVerifiedMethod = z.enum([
  "POSTCARD_CODE",
  "ID_DOCUMENT",
  "DATABASE_LOOKUP",
  "UNVERIFIED",
]);
export type AddressVerifiedMethod = z.infer<typeof AddressVerifiedMethod>;

/**
 * API caller roles. `agent` and `approver` are mutually exclusive (D12).
 *
 * `issuer` is the treasury side: it creates securities, mints them, and runs
 * corporate actions. Separate from `agent` because those operations create
 * value rather than move an approved payment, and separate from `approver`
 * because approving someone else's payout and issuing your own instrument are
 * different authorities that should not share a token.
 */
export const Role = z.enum(["agent", "approver", "bridge", "issuer"]);
export type Role = z.infer<typeof Role>;

/**
 * How a payment settles. Per payment, never global (D41).
 *
 * DIRECT is a plain transfer and stays the default: a payee who will not or
 * cannot claim still gets paid. HTLC routes the same payment through a hashed
 * timelock escrow — the payee has to reveal a secret to take the funds, which
 * produces an on-chain receipt, and anything unclaimed returns to the payer.
 */
export const SettlementMode = z.enum(["DIRECT", "HTLC"]);
export type SettlementMode = z.infer<typeof SettlementMode>;

/** Lifecycle of one escrow. CLAIMED and REFUNDED are mutually exclusive. */
/**
 * PENDING_LOCK means authorised but not yet funded — the payer's own wallet
 * still has to send the transaction. Everything after it is on chain.
 */
export const HtlcStatus = z.enum(["PENDING_LOCK", "LOCKED", "CLAIMED", "REFUNDED"]);
export type HtlcStatus = z.infer<typeof HtlcStatus>;

/**
 * How a recipient acknowledged receipt.
 *
 * Two routes to the same fact. EIP712_SIGNATURE is asked for after a direct
 * transfer; HTLC_CLAIM falls out of the payee taking the money, so it cannot be
 * declined without also declining the payment (D41).
 */
export const AcknowledgmentMethod = z.enum(["EIP712_SIGNATURE", "HTLC_CLAIM"]);
export type AcknowledgmentMethod = z.infer<typeof AcknowledgmentMethod>;

/** A tokenized instrument's state. MATURED takes redemptions, not new coupons. */
export const SecurityStatus = z.enum(["ISSUED", "MATURED"]);
export type SecurityStatus = z.infer<typeof SecurityStatus>;

/** One confirmed on-chain operation against a security. */
export const SecurityEventKind = z.enum([
  "ISSUED",
  "PREPARED",
  "MINTED",
  "TRANSFERRED",
  "COUPON_SET",
  "MATURITY_UPDATED",
  "REDEEMED",
]);
export type SecurityEventKind = z.infer<typeof SecurityEventKind>;

/** The payee's answer at P4. A DENY carries no signature — refusing needs no proof. */
export const PayeeConsentDecision = z.enum(["ACCEPTED", "DENIED"]);
export type PayeeConsentDecision = z.infer<typeof PayeeConsentDecision>;

/**
 * What a party is being told. IDENTITY_MISMATCH is the security-relevant one:
 * it makes a failed identity probe visible to the person being probed, instead
 * of failing silently in the attacker's favour (D62).
 */
export const NotificationKind = z.enum([
  "CONSENT_REQUESTED",
  "IDENTITY_MISMATCH",
  "FUNDS_LOCKED",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;
