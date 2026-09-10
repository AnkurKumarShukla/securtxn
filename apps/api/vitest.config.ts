import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These suites share one Postgres database and assert on unique
    // constraints (one DigiLocker identity per vendor, one wallet version per
    // vendor). Running files in parallel makes them race each other and fail
    // intermittently for reasons that have nothing to do with the code.
    fileParallelism: false,
    // Real signature verification and database round-trips are slower than
    // pure unit tests, and a single flow test now walks a payment through
    // DigiLocker onboarding, three EIP-712 signatures, payee consent and a
    // decision — the duplicate-invoice case does all of that twice.
    testTimeout: 45_000,
  },
});
