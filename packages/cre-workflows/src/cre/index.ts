// Subpath entry point: "@cp/cre-workflows/cre". Kept separate from the
// package root deliberately — see the comment in ../index.ts for why.
// Import from here only when @chainlink/cre-sdk is an acceptable dependency
// for the consumer (the CRE workflow's own build, and eventually apps/api's
// container.ts once Phase 5 wires in CreVendorMatcher for real).

// The caller-side pieces (CreVendorMatcher, the gateway client) deliberately
// do NOT live in this package at all. They import node:crypto, and the CRE
// SDK's `restricted-node-modules` types make node builtins `never` for every
// file covered by this package's tsconfig — so merely having them here failed
// the workflow's WASM build with "Type 'never' has no call signatures", even
// though nothing the workflow imports ever touched them. They live in
// apps/api/src/modules/vendorMatch/ instead, which is where the caller is.
export { vendorMatchHandler, initWorkflow } from "./workflow.js";
export type { VendorMatchWorkflowConfig, VendorMatchTriggerInput } from "./workflow.js";
