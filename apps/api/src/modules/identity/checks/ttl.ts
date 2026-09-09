// Check 4 of 4: TTL capture.
//
// KycRes carries a ttl, observed as issue + 1 year. CONFIRMED is therefore
// time-bounded, not permanent: re-verification must be scheduled before this
// date or the vendor's identity silently goes stale while still marked
// verified (D06).
//
// Spec: docs/architecture.md §4.7

import type { AadhaarDocument } from "../parse/aadhaar.js";
import { parseFlexibleDate } from "../normalise/index.js";

export type TtlResult = {
  /** A usable ttl was found and parsed. */
  captured: boolean;
  ttl: Date | null;
  /** Already past — the document is stale on arrival and must not confirm. */
  expired: boolean;
  reason: string | null;
};

export function checkTtl(aadhaar: AadhaarDocument, now: Date = new Date()): TtlResult {
  if (!aadhaar.ttl) {
    return { captured: false, ttl: null, expired: false, reason: "KycRes carries no ttl" };
  }

  const ttl = parseFlexibleDate(aadhaar.ttl);
  if (!ttl) {
    return { captured: false, ttl: null, expired: false, reason: "KycRes ttl is unparseable" };
  }

  const expired = ttl.getTime() <= now.getTime();
  return {
    captured: true,
    ttl,
    expired,
    reason: expired ? "KycRes ttl has already passed" : null,
  };
}
