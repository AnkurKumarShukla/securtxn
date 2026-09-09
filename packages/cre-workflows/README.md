# @cp/cre-workflows

Confidential vendor matching. Two implementations of one interface.

```
src/
  vendorMatch.ts   the interface — the only thing apps/api imports
  scoring/         match logic shared by both implementations
  fallback/        runs in-process; no enclave, no access gate
  cre/             workflow.ts (TEE handler) + the VendorMatcher adapter
```

The fallback is not throwaway. It is the reference implementation the CRE
version is tested against, and the reason Phases 1-4 are not blocked on
enrollment (§8).

`cre workflow simulate` verifies logic only. It is not a real enclave and must
never be cited as a security demonstration (§4.4).
