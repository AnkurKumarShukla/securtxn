// Issues a bond on Hedera testnet through the ATS factory.
//
//   pnpm --filter @cp/contracts deploy:testnet -- --dry-run
//   pnpm --filter @cp/contracts deploy:testnet
//
// A dry run reads the resolver and reports what would be deployed without
// spending anything — worth doing first, because a malformed struct reverts
// after the gas is gone.
//
// Spec: docs/architecture.md §4.5

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { BondIssuer, CONFIG_ID, ROLES, completeIsin, hashscanUrl } from "../src/index.js";

function loadEnv(startDir = process.cwd()): void {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return process.loadEnvFile(candidate);
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");

  const chainId = Number(process.env.HEDERA_CHAIN_ID ?? 296);
  const issuer = new BondIssuer({
    chainId,
    rpcUrl: required("HEDERA_JSON_RPC_URL"),
    mirrorNodeUrl: required("HEDERA_MIRROR_NODE_URL"),
    factoryAddress: required("ATS_FACTORY_ADDRESS"),
    resolverAddress: required("ATS_RESOLVER_ADDRESS"),
    issuerPrivateKey: required("ATS_ISSUER_PRIVATE_KEY"),
    // Hedera's relay under-estimates gas for diamond deploys; a generous floor
    // costs nothing extra since unused gas is not charged.
    gasLimit: 15_000_000n,
  });

  // A receivable, not a generic token: this is the invoice the platform has
  // already verified, tokenized so its lifecycle is on-chain (§4.5).
  const startingDate = new Date();
  const maturityDate = new Date(startingDate.getTime() + 90 * 24 * 60 * 60 * 1000);

  const params = {
    name: "Confirmed Payee Receivable 2026-Q3",
    symbol: "CPR26Q3",
    // The factory enforces the ISO 6166 check digit, so it is computed here
    // rather than hand-written — a wrong one reverts after the gas is spent.
    isin: completeIsin("US000CPR26Q"),
    decimals: 2,
    currency: "USD",
    // One token = one dollar of receivable. 12,500.50 tokens at 2 decimals,
    // each with a nominal value of 1.00 USD, gives a face value matching the
    // seeded invoice — and stays divisible for partial settlement.
    maxSupply: 1_250_050n,
    nominalValue: 100n,
    nominalValueDecimals: 2,
    startingDate,
    maturityDate,
  };

  const version = await issuer.latestBondConfigVersion();

  console.log("issuer account   :", issuer.issuerAddress);
  console.log("factory          :", process.env.ATS_FACTORY_ADDRESS);
  console.log("resolver         :", process.env.ATS_RESOLVER_ADDRESS);
  console.log("bond config id   :", CONFIG_ID.BOND);
  console.log("config version   :", version.toString(), "(latest registered)");
  console.log("internal KYC     : true  <- what makes grantKyc meaningful");
  console.log("roles granted    :", Object.keys(ROLES).join(", "));
  console.log("name / symbol    :", params.name, "/", params.symbol);
  console.log("isin             :", params.isin);
  console.log("nominal / unit   :", params.nominalValue.toString(), params.currency, `(${params.nominalValueDecimals} dp)`);
  console.log("max supply       :", params.maxSupply.toString(), "units → face 12,500.50 USD");
  console.log("maturity         :", maturityDate.toISOString().slice(0, 10));
  console.log("regulation       : REG_S / NONE  (offering outside the US)");

  if (dryRun) {
    console.log("\nDry run: nothing was submitted.");
    return;
  }

  console.log("\nSubmitting deployBond...");
  const result = await issuer.issue(params);

  console.log("\n  bond address :", result.bondAddress);
  console.log("  tx           :", result.txHash);
  console.log("  hashscan     :", hashscanUrl(chainId, "contract", result.bondAddress));
  console.log("\nSet this in .env:\n");
  console.log(`ATS_SECURITY_ID=${result.bondAddress}`);
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
