// End-to-end proof of the CRE vendor match against the DEPLOYED workflow,
// driven through the production path: the real container, the real
// CreVendorMatcher, the real gateway, the real callback endpoint, the real
// database row.
//
// Deliberately NOT the same check as invoke-workflow.mjs. That proves an
// execution reached SUCCESS — and SUCCESS only means the handler did not
// throw, so a matcher that always answered MATCHED would look identical across
// all four cases (D44). This asserts the VERDICT, which is readable at all only
// because of the callback (D48).
//
// Requires the API running and reachable at the DEPLOYED config's apiBaseUrl
// (the ngrok tunnel — the DON calls that host, not localhost).
//
//   pnpm --filter @cp/api cre:e2e
//   dotenv -e ../../.env -- tsx scripts/cre-e2e.ts

import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../src/config/index.js";
import { createContainer } from "../src/container.js";
import { GatewayRateLimitedError } from "../src/modules/vendorMatch/creGateway.js";

const V = "00000000-0000-4000-8000-000000000001";
const W = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/**
 * Each case names the verdict the deployed workflow must reach. The negative
 * cases carry the weight — they are what an always-MATCHED stub would fail.
 */
const CASES = [
  {
    label: "MATCHED",
    expect: { match: true, reasonCode: "MATCHED" },
    input: {
      vendorId: V,
      claimedLegalName: "MERIDIAN COMPONENTS PRIVATE LIMITED",
      walletAddress: W,
      network: "ethereum",
      tokenContract: T,
    },
  },
  {
    label: "WALLET_NOT_ON_FILE",
    expect: { match: false, reasonCode: "WALLET_NOT_ON_FILE" },
    input: {
      vendorId: V,
      claimedLegalName: "Meridian Components Pvt Ltd",
      walletAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
    },
  },
  {
    label: "NAME_BELOW_THRESHOLD",
    expect: { match: false, reasonCode: "NAME_BELOW_THRESHOLD" },
    input: {
      vendorId: V,
      claimedLegalName: "Totally Different Corp",
      walletAddress: W,
      network: "ethereum",
      tokenContract: T,
    },
  },
  {
    label: "VENDOR_NOT_FOUND",
    expect: { match: false, reasonCode: "VENDOR_NOT_FOUND" },
    input: {
      vendorId: "00000000-0000-4000-8000-00000000dead",
      claimedLegalName: "Nobody Ltd",
      walletAddress: W,
      network: "ethereum",
    },
  },
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

// Force the CRE path regardless of what .env selects, so this script always
// tests what it claims to test.
const container = createContainer({ ...base, VENDOR_MATCHER: "cre" }, prisma);

console.log(`workflow: ${base.CRE_WORKFLOW_ID}`);
console.log(`gateway : ${base.CRE_GATEWAY_URL}\n`);

let failures = 0;

for (const { label, input, expect } of CASES) {
  let verdict: { match: boolean; score: number; reasonCode: string } | undefined;

  // The gateway rate-limits back-to-back invocations. A 429 says nothing about
  // the workflow, so it is retried rather than counted as a failed case.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      verdict = await container.vendorMatcher.match(input);
      break;
    } catch (error) {
      if (error instanceof GatewayRateLimitedError) {
        await sleep(15_000);
        continue;
      }
      console.log(`✗ ${label.padEnd(20)} threw: ${(error as Error).message}`);
      failures++;
      break;
    }
  }

  if (!verdict) {
    if (failures === 0) console.log(`✗ ${label.padEnd(20)} no verdict (still rate limited)`);
    failures++;
    continue;
  }

  const ok = verdict.match === expect.match && verdict.reasonCode === expect.reasonCode;
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${label.padEnd(20)} -> ${verdict.reasonCode} ` +
      `match=${verdict.match} score=${verdict.score}` +
      (ok ? "" : `  EXPECTED ${expect.reasonCode} match=${expect.match}`),
  );

  await sleep(15_000);
}

await prisma.$disconnect();

console.log(
  failures === 0
    ? "\nall four verdicts correct, produced by the deployed workflow"
    : `\n${failures}/${CASES.length} cases wrong`,
);
process.exit(failures === 0 ? 0 : 1);
