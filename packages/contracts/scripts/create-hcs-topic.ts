// Creates the consensus topic evidence roots are published to. One-time setup.
//
//   pnpm --filter @cp/contracts create:topic
//
// The topic is created ONCE per environment and its id goes in the config. It
// is deliberately not created on demand by the API: a topic created at runtime
// would mean a fresh one after any config slip, and every anchor written before
// it would become unfindable — which is the one thing an audit trail must never
// do.
//
// No submit key is set. Anyone may write to the topic; only our messages carry
// our payer account id, and the value here is public readability, not private
// writability.
//
// Spec: docs/architecture.md §4.8

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { HcsAnchorClient } from "../src/index.js";

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

  const chainId = Number(process.env.HEDERA_CHAIN_ID ?? 296);
  const client = new HcsAnchorClient({
    accountId: required("ATS_ISSUER_ACCOUNT_ID"),
    privateKey: required("ATS_ISSUER_PRIVATE_KEY"),
    network: chainId === 295 ? "mainnet" : "testnet",
    mirrorNodeUrl: required("HEDERA_MIRROR_NODE_URL"),
  });

  try {
    console.log(`operator : ${process.env.ATS_ISSUER_ACCOUNT_ID} (${client.operatorEvmAddress})`);

    const existing = process.env.HCS_TOPIC_ID;
    if (existing) {
      // Refused rather than replaced. A second topic silently orphans every
      // anchor written to the first.
      console.log(`\nHCS_TOPIC_ID is already set to ${existing}.`);
      console.log("Delete it from .env first if you genuinely want a new topic.");
      return;
    }

    const topicId = await client.createTopic("confirmed-payee evidence anchors v1");
    console.log(`\nCreated topic ${topicId}`);
    console.log("\nAdd to .env:");
    console.log(`HCS_TOPIC_ID=${topicId}`);
    console.log(
      `\nhashscan: https://hashscan.io/${chainId === 295 ? "mainnet" : "testnet"}/topic/${topicId}`,
    );
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message.split("\n")[0] : err);
  process.exitCode = 1;
});
