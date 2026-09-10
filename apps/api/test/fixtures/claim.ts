// The sender's claim about a payee, as digests (D62).
//
// Suites that create a PaymentRequest row directly — because they are about
// what happens AFTER approval — still need the two digest columns the match
// reads. They must be produced EXACTLY as PaymentService.create() produces
// them, so this calls the same two functions rather than reimplementing them:
// a helper that hashed differently would let a test pass against a claim the
// real matcher would reject.

import { canonicalEntityName } from "@cp/cre-workflows";
import { hmac } from "../../src/lib/crypto.js";

/** The `claimedPayee*Hmac` pair for a sender who names the payee correctly. */
export function claimDigests(
  name: string,
  pan: string,
  pepper: string,
): { claimedPayeeNameHmac: string | null; claimedPayeePanHmac: string } {
  const canonical = canonicalEntityName(name);
  return {
    claimedPayeeNameHmac: canonical ? hmac(canonical, pepper) : null,
    claimedPayeePanHmac: hmac(pan, pepper),
  };
}
