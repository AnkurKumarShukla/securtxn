// The vendor-match contract. Both implementations satisfy it and both pass the
// same test suite — that equivalence is what makes the CRE swap a one-line
// change in the api's DI container.
//
// Everything identity-shaped here is a DIGEST (D62). The enclave has no crypto,
// so the caller HMACs both sides with the pepper and this layer compares opaque
// bytes. No plaintext name or PAN crosses into the workflow, and the pepper
// never leaves the API process.
//
// Spec: docs/architecture.md §4.4, docs/payment-flow.md P6

export type VendorMatchInput = {
  vendorId: string;
  /**
   * HMAC(canonicalEntityName(name the SENDER believes they are paying), pepper).
   *
   * Computed server-side from what the sender typed, using the same
   * canonicalisation the stored digest was written with — otherwise two
   * spellings of one company would never agree.
   */
  claimedNameHmac: string;
  /** HMAC(PAN the sender believes they are paying, pepper). */
  claimedPanHmac: string;
  /** Untrusted routing, straight off the invoice. The identity is what verifies it. */
  walletAddress: string;
  network: string;
  tokenContract?: string;
};

/**
 * No score.
 *
 * Digest comparison is exact, so there is no meaningful number between 0 and 1
 * to report. Returning a fake one — 1.0 for a match, 0 otherwise — would invite
 * a caller to build a threshold on it and believe the threshold means something.
 */
export type VendorMatchResult = { match: boolean; reasonCode: string };

export interface VendorMatcher {
  match(input: VendorMatchInput): Promise<VendorMatchResult>;
}

/**
 * The fallback runs inside apps/api and needs payee records, but this package
 * must not depend on Prisma. The api injects a lookup instead.
 */
export type VendorLookup = (vendorId: string) => Promise<{
  legalNameHmac: string | null;
  panNumberHmac: string | null;
  wallets: { address: string; network: string; tokenContract: string | null }[];
} | null>;
