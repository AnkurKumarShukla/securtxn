// Deliberately does NOT re-export anything from ./cre/ here. Those files
// import @chainlink/cre-sdk, whose dist/index.js uses a directory import
// Node's ESM resolver rejects outside a bundler ("Directory import '.../dist/
// sdk' is not supported"). Barrelling it into this root entry point would
// make every consumer of @cp/cre-workflows — including apps/api's tests,
// which only want FallbackVendorMatcher — transitively fail to import.
// Anything that actually needs the CRE SDK imports "@cp/cre-workflows/cre"
// instead (see ./cre/index.ts), which is an opt-in, not an ambient cost.

export { FallbackVendorMatcher, MATCH_REASONS } from "./fallback/FallbackVendorMatcher.js";
export { nameSimilarity, normaliseEntityName } from "./scoring/index.js";

export type {
  VendorMatcher,
  VendorMatchInput,
  VendorMatchResult,
  VendorLookup,
} from "./vendorMatch.js";
