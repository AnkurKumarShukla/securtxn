import { FallbackVendorMatcher } from "../src/fallback/FallbackVendorMatcher.js";
import type { VendorLookup } from "../src/vendorMatch.js";
import { runVendorMatcherContract } from "./vendorMatcher.contract.js";

// No minScore any more: digest comparison is exact, so the two implementations
// no longer even have a knob that could be configured differently (D62).
runVendorMatcherContract(
  "FallbackVendorMatcher",
  (lookup: VendorLookup) => new FallbackVendorMatcher({ lookup }),
);
