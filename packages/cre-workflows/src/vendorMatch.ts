// The vendor-match contract. Both implementations satisfy it and both pass the
// same test suite — that equivalence is what makes the CRE swap a one-line
// change in the api's DI container.
// Spec: docs/architecture.md §4.4

export type VendorMatchInput = {
  vendorId: string;
  claimedLegalName: string;
  walletAddress: string;
  network: string;
  tokenContract?: string;
};

export type VendorMatchResult = { match: boolean; score: number; reasonCode: string };

export interface VendorMatcher {
  match(input: VendorMatchInput): Promise<VendorMatchResult>;
}

/**
 * The fallback runs inside apps/api and needs vendor records, but this package
 * must not depend on Prisma. The api injects a lookup instead.
 */
export type VendorLookup = (vendorId: string) => Promise<{
  legalName: string;
  wallets: { address: string; network: string; tokenContract: string | null }[];
} | null>;
