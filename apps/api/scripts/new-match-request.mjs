// Creates a PENDING VendorMatchRequest and writes the trigger payload for it.
//
// Mirrors what CreVendorMatcher does before invoking (D48): the row must exist
// first, or the workflow's callback is rejected as unsolicited. Used to drive
// `cre workflow simulate` and the deployed workflow against a real row.
//
// Usage (from the repo root):
//   node packages/cre-workflows/scripts/new-match-request.mjs <case> [outFile]
//
// Cases mirror the four verdict branches; see invoke-workflow.mjs.

import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const V = "00000000-0000-4000-8000-000000000001";
const W = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const CASES = {
  MATCHED: { vendorId: V, claimedLegalName: "MERIDIAN COMPONENTS PRIVATE LIMITED", walletAddress: W, network: "ethereum", tokenContract: T },
  WALLET_NOT_ON_FILE: { vendorId: V, claimedLegalName: "Meridian Components Pvt Ltd", walletAddress: "0x1234567890123456789012345678901234567890", network: "ethereum" },
  NAME_BELOW_THRESHOLD: { vendorId: V, claimedLegalName: "Totally Different Corp", walletAddress: W, network: "ethereum", tokenContract: T },
  VENDOR_NOT_FOUND: { vendorId: "00000000-0000-4000-8000-00000000dead", claimedLegalName: "Nobody Ltd", walletAddress: W, network: "ethereum" },
};

const which = process.argv[2] ?? "MATCHED";
const outFile = process.argv[3];
const input = CASES[which];
if (!input) throw new Error(`unknown case ${which}; expected one of ${Object.keys(CASES).join(", ")}`);

const prisma = new PrismaClient();
const row = await prisma.vendorMatchRequest.create({
  data: {
    vendorId: input.vendorId,
    walletAddress: input.walletAddress,
    network: input.network,
  },
  select: { id: true },
});
await prisma.$disconnect();

const payload = { ...input, requestId: row.id };
if (outFile) writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload));
