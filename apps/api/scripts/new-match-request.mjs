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
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const V = "00000000-0000-4000-8000-000000000001";
const W = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const PEPPER = process.env.HMAC_PEPPER;
if (!PEPPER) throw new Error("HMAC_PEPPER is not set; run this through dotenv -e .env");

// The same two functions the API applies before calling the enclave (D62).
// Inlined rather than imported so this stays a plain .mjs script with no build
// step; they must stay in step with apps/api/src/lib/crypto.ts and
// packages/cre-workflows/src/scoring/nameScore.ts.
const SUFFIXES = new Set([
  "private", "pvt", "limited", "ltd", "llp", "inc", "incorporated", "corp",
  "corporation", "company", "co", "plc", "gmbh", "sa", "srl", "bv", "nv", "ag", "pte",
]);
const hmacOf = (value) =>
  createHmac("sha256", PEPPER).update(value.trim().toUpperCase()).digest("hex");
const canonicalName = (value) => {
  const tokens = value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => !SUFFIXES.has(t));
  // NULL when nothing distinguishing survives ("Pvt Ltd"). The real
  // canonicaliser refuses these rather than returning a digest that would
  // match every other suffix-only name, and a copy that quietly differed here
  // would be worse than no copy.
  return kept.length === 0 ? null : [...new Set(kept)].sort().join(" ");
};
const nameHmac = (value) => {
  const canonical = canonicalName(value);
  if (canonical === null) throw new Error(`'${value}' has no distinguishing tokens to hash`);
  return hmacOf(canonical);
};
const PAN = "ABCDE1234F";

const CASES = {
  MATCHED: { vendorId: V, claimedNameHmac: nameHmac("MERIDIAN COMPONENTS PRIVATE LIMITED"), claimedPanHmac: hmacOf(PAN), walletAddress: W, network: "ethereum", tokenContract: T },
  WALLET_NOT_ON_FILE: { vendorId: V, claimedNameHmac: nameHmac("Meridian Components Pvt Ltd"), claimedPanHmac: hmacOf(PAN), walletAddress: "0x1234567890123456789012345678901234567890", network: "ethereum" },
  IDENTITY_MISMATCH: { vendorId: V, claimedNameHmac: nameHmac("Totally Different Corp"), claimedPanHmac: hmacOf(PAN), walletAddress: W, network: "ethereum", tokenContract: T },
  VENDOR_NOT_FOUND: { vendorId: "00000000-0000-4000-8000-00000000dead", claimedNameHmac: nameHmac("Nobody Ltd"), claimedPanHmac: hmacOf("QQQQQ0000Q"), walletAddress: W, network: "ethereum" },
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
