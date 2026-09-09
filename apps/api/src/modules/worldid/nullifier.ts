// Nullifier normalisation (D49a).
//
// World returns nullifiers as 0x-prefixed hex of a 256-bit field element, with
// leading zeros STRIPPED. Observed live: a merkle_root came back 63 hex chars
// in one run and 64 in the next. The nullifier is the same kind of value, so
// the same person can legitimately produce "0x0abc…" and "0xabc…" on different
// runs — roughly one time in sixteen.
//
// Comparing or storing those as strings is therefore unsafe in both directions:
// a continuity check would reject a legitimate user, and a uniqueness index
// would miss a replay. Everything below converts to a canonical decimal string
// before the value is allowed anywhere near the database.

/** Field elements are 256-bit; anything wider is not a nullifier. */
const MAX = (1n << 256n) - 1n;

const HEX = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Canonical decimal form of a 0x-hex nullifier, for `NUMERIC(78,0)` storage.
 *
 * Throws rather than coercing: a malformed nullifier means the payload is not
 * what we think it is, and silently storing `0` or `NaN` would poison both the
 * uniqueness index and every later continuity comparison.
 */
export function nullifierToDecimal(hex: string): string {
  const value = hex.trim();

  if (!HEX.test(value)) {
    throw new Error(`nullifier is not 0x-prefixed hex of at most 32 bytes: ${truncate(value)}`);
  }

  const asBigInt = BigInt(value);

  if (asBigInt > MAX) {
    throw new Error(`nullifier exceeds 256 bits: ${truncate(value)}`);
  }

  return asBigInt.toString(10);
}

/** Never echo a full identifier into an error message or log. */
function truncate(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
