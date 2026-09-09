// Demonstrates the receivable's lifecycle, and proves the compliance gate is
// real rather than decorative.
//
//   pnpm --filter @cp/contracts lifecycle
//
// The sequence:
//
//   1. mint units of the receivable to the KYC-granted payee
//   2. the payee attempts a transfer to an address with NO KYC   -> REVERTS
//   3. the platform grants KYC to that address                   -> allowed
//   4. the same transfer is retried                              -> SUCCEEDS
//
// Step 2 is the point. A transfer failing on chain, for an address our own
// verification pipeline never confirmed, is the difference between a compliance
// control and a badge.
//
// Spec: docs/architecture.md §4.5

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createAddressResolver,
  hashscanUrl,
  hederaChain,
  KYC_ABI,
  NO_EXPIRY_SECONDS,
} from "../src/index.js";

/** Anvil account #1 — the seeded payee. Its key is public; testnet only. */
const PAYEE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** Anvil account #2 — a counterparty the platform has never verified. */
const STRANGER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const ROLE_ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f" as const;

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

const TOKEN_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

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

  const issuer = privateKeyToAccount(required("ATS_ISSUER_PRIVATE_KEY") as Hex);
  const payee = privateKeyToAccount(PAYEE_KEY);
  const stranger = privateKeyToAccount(STRANGER_KEY);

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const asIssuer = createWalletClient({ chain, transport: http(rpcUrl), account: issuer });
  const asPayee = createWalletClient({ chain, transport: http(rpcUrl), account: payee });

  const security = await createAddressResolver(required("HEDERA_MIRROR_NODE_URL")).toEvmAddress(
    required("ATS_SECURITY_ID"),
  );

  const gas = 1_000_000n;
  const confirm = async (label: string, hash: Hex): Promise<void> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    console.log(`   ${label} — ${hash}`);
  };

  const balance = (who: Address) =>
    publicClient.readContract({ address: security, abi: TOKEN_ABI, functionName: "balanceOf", args: [who] });
  const kyc = (who: Address) =>
    publicClient.readContract({ address: security, abi: KYC_ABI, functionName: "getKycStatusFor", args: [who] });

  console.log(`security : ${process.env.ATS_SECURITY_ID} (${security})`);
  console.log(`payee    : ${payee.address}  kyc=${await kyc(payee.address)}`);
  console.log(`stranger : ${stranger.address}  kyc=${await kyc(stranger.address)}`);

  // --- 1. issuance ---------------------------------------------------------
  console.log("\n1. Mint 500.00 units to the verified payee");

  const hasIssuerRole = await publicClient.readContract({
    address: security,
    abi: ACCESS_CONTROL_ABI,
    functionName: "hasRole",
    args: [ROLE_ISSUER, issuer.address],
  });
  if (!hasIssuerRole) {
    await confirm(
      "ROLE_ISSUER granted",
      await asIssuer.writeContract({
        address: security,
        abi: ACCESS_CONTROL_ABI,
        functionName: "grantRole",
        args: [ROLE_ISSUER, issuer.address],
        chain,
        account: issuer,
        gas,
      }),
    );
  }

  const amount = 50_000n; // 500.00 at 2 decimals
  await confirm(
    "minted",
    await asIssuer.writeContract({
      address: security,
      abi: TOKEN_ABI,
      functionName: "mint",
      args: [payee.address, amount],
      chain,
      account: issuer,
      gas: 2_000_000n,
    }),
  );
  console.log(`   payee balance: ${await balance(payee.address)}`);

  // --- 2. the compliance gate --------------------------------------------
  console.log("\n2. Payee attempts a transfer to an address with NO KYC");
  let rejected = false;
  try {
    await publicClient.simulateContract({
      address: security,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [stranger.address, 10_000n],
      account: payee,
    });
    console.log("   UNEXPECTED: the transfer would succeed");
  } catch (err) {
    rejected = true;
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`   REJECTED ON CHAIN — ${message}`);
  }

  // --- 3. grant, then retry ----------------------------------------------
  console.log("\n3. Platform grants KYC to that address");
  await confirm(
    "kyc granted",
    await asIssuer.writeContract({
      address: security,
      abi: KYC_ABI,
      functionName: "grantKyc",
      args: [
        stranger.address,
        "demo-counterparty-credential",
        BigInt(Math.floor(Date.now() / 1000)),
        // Never 0 — the contract rejects it as InvalidDates.
        BigInt(Math.floor(Date.now() / 1000)) + NO_EXPIRY_SECONDS,
        issuer.address,
      ],
      chain,
      account: issuer,
      gas,
    }),
  );
  console.log(`   stranger kyc: ${await kyc(stranger.address)}`);

  console.log("\n4. The same transfer, retried");
  await confirm(
    "transferred",
    await asPayee.writeContract({
      address: security,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [stranger.address, 10_000n],
      chain,
      account: payee,
      gas: 2_000_000n,
    }),
  );

  console.log(`   payee    : ${await balance(payee.address)}`);
  console.log(`   recipient: ${await balance(stranger.address)}`);
  console.log(`   supply   : ${await publicClient.readContract({ address: security, abi: TOKEN_ABI, functionName: "totalSupply" })}`);

  console.log("\nSummary");
  console.log(`  transfer blocked before KYC : ${rejected ? "yes" : "NO — investigate"}`);
  console.log(`  transfer allowed after KYC  : yes`);
  console.log(`  hashscan: ${hashscanUrl(chainId, "contract", required("ATS_SECURITY_ID"))}`);
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message.split("\n")[0] : err);
  process.exit(1);
});
