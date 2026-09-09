import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These suites share one Postgres database and assert on unique
    // constraints (one DigiLocker identity per vendor, one wallet version per
    // vendor). Running files in parallel makes them race each other and fail
    // intermittently for reasons that have nothing to do with the code.
    fileParallelism: false,
    // Real signature verification and database round-trips are slower than
    // pure unit tests.
    testTimeout: 20_000,
  },
});
