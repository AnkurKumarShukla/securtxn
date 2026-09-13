// Display formatting. Masking rules for Aadhaar last-4 and PAN live here.
// Spec: docs/architecture.md 5

/**
 * Middle-truncates a hash or an address.
 *
 * Both ends are kept because both ends carry the information a human uses to
 * compare two addresses at a glance — truncating only the tail makes every
 * address on the page look alike, which is precisely the failure mode this
 * product exists to prevent. The full value is always available to copy.
 */
export function truncate(value: string, chars = 6): string {
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

/**
 * How long until an ISO timestamp, in words.
 *
 * Used for the escrow timelock, which is otherwise a bare ISO string — the
 * least readable value on the payee's screen, and the one that decides whether
 * they still have time to claim.
 */
export function until(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "elapsed";
  return `in ${duration(ms)}`;
}

/** A coarse duration: the caller wants "4m 12s", never "4m 12.338s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Milliseconds as the step timing badge shows them. */
export function millis(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/**
 * Turns a SCREAMING_SNAKE enum into something readable, without losing it.
 *
 * The decision engine's reason codes (`VENDOR_MATCH_FAILED`) and the challenge
 * triggers (`SELFIE_CHECK_STALE`) are the most important strings on the screen.
 * They are shown as-is in monospace where the exact code matters and through
 * this where a sentence reads better.
 */
export function humanise(code: string): string {
  return code.toLowerCase().replace(/_/g, " ");
}

/**
 * Aadhaar, masked.
 *
 * The API only ever returns `aadhaarLast4`, and no input in this app may accept
 * a full Aadhaar number — receiving one creates Data Vault obligations the flow
 * is designed to avoid (README, §3). This exists so the display shape is
 * consistent, never to mask a value we should not be holding.
 */
export function aadhaarMasked(last4: string | null | undefined): string {
  return last4 ? `XXXX XXXX ${last4}` : "—";
}
