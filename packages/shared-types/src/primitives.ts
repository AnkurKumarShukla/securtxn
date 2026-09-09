// Value-level schemas reused across every request and response shape.
//
// These exist so a format rule is written once. An address regex copied into
// six route schemas will eventually disagree with itself, and the one place it
// disagrees is the place that accepts a malformed payout address.

import { z } from "zod";

/** 20-byte EVM address. Format only — checksum validation belongs to viem. */
export const EvmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address");

/** 32 bytes of hex: keccak256 digests, commitments, and session nonces. */
export const Bytes32 = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be 0x-prefixed 32 bytes of hex");

/**
 * Bare 32-byte hex digest, no 0x prefix — the form stored in the hash chain.
 *
 * Unprefixed because the genesis value is "0" x 64 and a prefix would make the
 * first link a different shape from every other one.
 */
export const Bytes32Hex = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/, "must be 64 hex characters");

/** 65-byte ECDSA signature (r || s || v), as produced by an EIP-712 signer. */
export const Signature = z
  .string()
  .regex(/^0x[a-fA-F0-9]{130}$/, "must be a 0x-prefixed 65-byte signature");

/**
 * Money as a decimal string, never a JS number.
 *
 * Doubles cannot represent 0.1 exactly, and these values move funds
 * irreversibly. The database column is Decimal(38,18) (D25), so 18 fractional
 * digits is the ceiling; anything longer would be silently truncated on write.
 */
export const AmountString = z
  .string()
  .regex(/^\d{1,20}(\.\d{1,18})?$/, "must be a decimal string with at most 18 decimal places")
  .refine((v) => Number.parseFloat(v) > 0, "must be greater than zero");

/** Networks the platform can address. Widen as chains are added. */
export const Network = z.enum(["ethereum", "hedera"]);
export type Network = z.infer<typeof Network>;

/** ISO 3166-1 alpha-2, uppercase. */
export const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 country code");

/**
 * E.164-ish. Deliberately permissive on separators: this value is compared
 * against a registry-supplied contact (D05), and rejecting a legitimate
 * formatting difference would block a wallet confirmation.
 */
export const PhoneNumber = z
  .string()
  .min(7)
  .max(24)
  .regex(/^[+0-9][0-9 ()\-.]*$/, "must look like a phone number");

export const Uuid = z.string().uuid();

/** ISO 8601 timestamp, as it appears on the wire. */
export const IsoDateTime = z.string().datetime();
