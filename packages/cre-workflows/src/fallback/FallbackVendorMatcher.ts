// Non-confidential vendor matcher.
//
// NOT a placeholder. This is the reference implementation the CRE version is
// tested against, and it produces the real matchScore the decision engine acts
// on. A stub returning `{ match: true, score: 1 }` would make every
// decision-engine test meaningless (D09, D21).
//
// The difference from the CRE version is confidentiality, not correctness:
// this fetches the vendor record in-process, where the enclave fetches it
// inside a TEE. The comparison itself is the *same code* in both — see
// evaluateMatch in ../matching.ts.
//
// Spec: docs/architecture.md §4.4

import { evaluateMatch } from "../matching.js";
import type {
  VendorLookup,
  VendorMatchInput,
  VendorMatchResult,
  VendorMatcher,
} from "../vendorMatch.js";

// Re-exported for existing importers; the definition now lives with the rule
// it belongs to.
export { MATCH_REASONS } from "../matching.js";

export type FallbackMatcherOptions = {
  lookup: VendorLookup;
  /**
   * Minimum name similarity to count as a match. Config, not a literal — it is
   * risk appetite, and different customers will set it differently (D08).
   */
  minScore: number;
};

export class FallbackVendorMatcher implements VendorMatcher {
  constructor(private readonly options: FallbackMatcherOptions) {}

  async match(input: VendorMatchInput): Promise<VendorMatchResult> {
    const vendor = await this.options.lookup(input.vendorId);
    return evaluateMatch(input, vendor, this.options.minScore);
  }
}
