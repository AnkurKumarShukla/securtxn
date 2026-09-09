// Reads the expected values for the recorded DigiLocker fixtures.
//
// WHY THIS INDIRECTION EXISTS: the fixtures are a real person's Aadhaar and
// PAN, and `fixtures/digilocker/` is gitignored for that reason. Tests that
// asserted the subject's Aadhaar last-4 or mobile number inline put that PII back
// into committed source, where the .gitignore could not help — a real mobile
// number, Aadhaar last-4, name, PAN prefix and home address would have shipped
// in a public hackathon repo.
//
// So the identifiers live only in the ignored fixture directory, and tests read
// them at runtime. Every test that uses this already skips when the fixtures
// are absent (`hasRealFixtures`), so a clean clone is unaffected.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export const REAL_FIXTURE_DIR = join(REPO_ROOT, "fixtures", "digilocker");

/** True when the recorded fixtures are present. Tests skip themselves when not. */
export const hasRealFixtures = existsSync(join(REAL_FIXTURE_DIR, "documents", "aadhaar.xml"));

export type FixtureOracle = {
  xmlSignatureVerified: boolean;
  crossDocConsistent: boolean;
  digilockerUserId: string;
  aadhaarLast4: string;
  aadhaarKycTtl: string;
  addressVerifiedMethod: string;
  resultingTier: string;
  verifiedMobile: string;
  legalFirstName: string;
  legalLastName: string;
  panPrefix: string;
  addressTerms: string[];
};

let cached: FixtureOracle | undefined;

/**
 * The oracle block from fixtures/digilocker/index.json.
 *
 * Throws rather than returning placeholders when the fixtures are missing: a
 * test that silently asserted against empty strings would pass while checking
 * nothing, which is worse than failing to run.
 */
export function fixtureOracle(): FixtureOracle {
  if (cached) return cached;

  if (!hasRealFixtures) {
    throw new Error(
      "DigiLocker fixtures are not present — guard the caller with `hasRealFixtures` before reading the oracle",
    );
  }

  const index = JSON.parse(readFileSync(join(REAL_FIXTURE_DIR, "index.json"), "utf8")) as {
    expected_check_results: FixtureOracle;
  };

  cached = index.expected_check_results;
  return cached;
}
