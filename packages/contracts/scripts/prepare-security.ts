// Prepares a deployed security so the platform can grant KYC against it.
//
//   pnpm --filter @cp/contracts prepare:security
//
// Two things the deploy does not do:
//
//   1. grant ROLE_SSI_MANAGER to the issuing account — without it `addIssuer`
//      reverts with a missing-role error
//   2. register that account as a trusted credential issuer — without it
//      `grantKyc` reverts with `AccountIsNotIssuer`, because ATS will not
//      accept a credential from an unknown issuer
//
// That second check is the point, not an obstacle: the token only honours KYC
// grants that cite an issuer it has been told to trust (D40).
//
// Idempotent — safe to re-run.
//
// Spec: docs/architecture.md §4.5

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAddressResolver, hashscanUrl, hederaChain, ROLES } from "../src/index.js";

const ACCESS_CONTROL_ABI = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_role", type: "bytes32" },
      { name: "_account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "_role", type: "bytes32" },
      { name: "_account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const SSI_ABI = [
  {
    type: "function",
    name: "addIssuer",
    stateMutability: "nonpayable",
    inputs: [{ name: "_issuer", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isIssuer",
    stateMutability: "view",
    inputs: [{ name: "_issuer", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** From contracts/constants/roles.sol. */
const ROLE_SSI_MANAGER =
  "0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1" as const;

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
  const rpcUrl = required("HEDERA_JSON_RPC_URL");
  const chain = hederaChain(chainId, rpcUrl);
  const account = privateKeyToAccount(required("ATS_ISSUER_PRIVATE_KEY") as Hex);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });
  const resolver = createAddressResolver(required("HEDERA_MIRROR_NODE_URL"));
  const security = await resolver.toEvmAddress(required("ATS_SECURITY_ID"));

  console.log("security :", process.env.ATS_SECURITY_ID, `(${security})`);
  console.log("account  :", account.address);
  console.log("");

  const send = async (label: string, hash: Hex): Promise<void> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
    console.log(`  ${label}: ${hash}`);
  };

  // 1. ROLE_SSI_MANAGER
  const hasSsiRole = await publicClient.readContract({
    address: security,
    abi: ACCESS_CONTROL_ABI,
    functionName: "hasRole",
    args: [ROLE_SSI_MANAGER, account.address as Address],
  });

  if (hasSsiRole) {
    console.log("  ROLE_SSI_MANAGER: already held");
  } else {
    await send(
      "ROLE_SSI_MANAGER granted",
      await walletClient.writeContract({
        address: security,
        abi: ACCESS_CONTROL_ABI,
        functionName: "grantRole",
        args: [ROLE_SSI_MANAGER, account.address as Address],
        chain,
        account,
        gas: 1_000_000n,
      }),
    );
  }

  // 2. trusted issuer
  const alreadyIssuer = await publicClient.readContract({
    address: security,
    abi: SSI_ABI,
    functionName: "isIssuer",
    args: [account.address as Address],
  });

  if (alreadyIssuer) {
    console.log("  trusted issuer  : already registered");
  } else {
    await send(
      "issuer registered",
      await walletClient.writeContract({
        address: security,
        abi: SSI_ABI,
        functionName: "addIssuer",
        args: [account.address as Address],
        chain,
        account,
        gas: 1_000_000n,
      }),
    );
  }

  console.log("\nRoles held:");
  for (const [name, role] of Object.entries(ROLES)) {
    const held = await publicClient.readContract({
      address: security,
      abi: ACCESS_CONTROL_ABI,
      functionName: "hasRole",
      args: [role as Hex, account.address as Address],
    });
    console.log(`  ${name.padEnd(22)} ${held ? "yes" : "no"}`);
  }

  console.log("\nhashscan:", hashscanUrl(chainId, "contract", required("ATS_SECURITY_ID")));
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
