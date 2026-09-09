import { FallbackVendorMatcher } from "../src/fallback/FallbackVendorMatcher.js";
import type { VendorLookup } from "../src/vendorMatch.js";
import { runVendorMatcherContract } from "./vendorMatcher.contract.js";

runVendorMatcherContract(
  "FallbackVendorMatcher",
  (lookup: VendorLookup) => new FallbackVendorMatcher({ lookup, minScore: 0.7 }),
);
