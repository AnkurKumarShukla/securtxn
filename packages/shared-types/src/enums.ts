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

/** API caller roles. `agent` and `approver` are mutually exclusive (D12). */
export const Role = z.enum(["agent", "approver", "bridge"]);
export type Role = z.infer<typeof Role>;
