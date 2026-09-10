// Deploys the PaymentHtlc escrow to Hedera and makes it a legal holder.
//
//   pnpm --filter @cp/contracts deploy:htlc
//
// TWO STEPS, AND THE SECOND IS THE INTERESTING ONE. Deploying the escrow is
// ordinary. Granting it KYC is not: the ATS security refuses transfers to any
// address the compliance layer has not approved, and the escrow is an address
// like any other. Without this grant every lock reverts.
//
// That is the compliance story working as intended rather than being bypassed
// by a contract. A escrow that could hold a regulated security without being
// approved to would be a hole in the control, not a feature of it.
//
// Spec: docs/architecture.md 4.5

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createAddressResolver,
  deployPaymentHtlc,
  hashscanUrl,
  hederaChain,
  KYC_ABI,
  NO_EXPIRY_SECONDS,
  PAYMENT_HTLC_COMPILER,
  ROLES,
} from "../src/index.js";

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

async function main(): Promise<void> {
  loadEnv();

  const chainId = Number(process.env.HEDERA_CHAIN_ID ?? 296);
  const rpcUrl = required("HEDERA_JSON_RPC_URL");
  const chain = hederaChain(chainId, rpcUrl);

  const deployer = privateKeyToAccount(required("ATS_ISSUER_PRIVATE_KEY") as Hex);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: deployer });

  console.log(`deployer : ${deployer.address}`);
  console.log(`compiler : solc ${PAYMENT_HTLC_COMPILER.version}, evm ${PAYMENT_HTLC_COMPILER.evmVersion}`);

  console.log("\n1. Deploy PaymentHtlc");
  const { address, txHash } = await deployPaymentHtlc({ wallet, publicClient });
  console.log(`   deployed at ${address}`);
  console.log(`   tx ${txHash}`);

  // Optional so the escrow can be deployed before a security exists. Skipping
  // it is stated out loud rather than silently, because a lock against an
  // un-granted escrow fails with a token error that reads like a bug.
  const securityId = process.env.ATS_SECURITY_ID;
  if (!securityId) {
    console.log("\n2. Skipped: ATS_SECURITY_ID is not set, so no KYC was granted");
  } else {
    console.log("\n2. Grant the escrow KYC on the security");
    const security = await createAddressResolver(
      required("HEDERA_MIRROR_NODE_URL"),
    ).toEvmAddress(securityId);

    const holdsManager = await publicClient.readContract({
      address: security,
      abi: ACCESS_CONTROL_ABI,
      functionName: "hasRole",
      args: [ROLES.KYC_MANAGER, deployer.address],
    });
    if (!holdsManager) {
      const grantRole = await wallet.writeContract({
        address: security,
        abi: ACCESS_CONTROL_ABI,
        functionName: "grantRole",
        args: [ROLES.KYC_MANAGER, deployer.address],
        chain,
        account: deployer,
        gas: 1_000_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: grantRole });
      console.log("   ROLE_KYC_MANAGER granted to the deployer");
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const grantKyc = await wallet.writeContract({
      address: security,
      abi: KYC_ABI,
      functionName: "grantKyc",
      args: [
        address,
        // Names what was approved and why, for anyone reading the chain later.
        "confirmed-payee-htlc-escrow",
        now,
        // Never 0 — the contract rejects that as InvalidDates.
        now + NO_EXPIRY_SECONDS,
        deployer.address,
      ],
      chain,
      account: deployer,
      gas: 1_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: grantKyc });
    if (receipt.status !== "success") throw new Error(`grantKyc reverted (${grantKyc})`);

    const status = await publicClient.readContract({
      address: security,
      abi: KYC_ABI,
      functionName: "getKycStatusFor",
      args: [address],
    });
    console.log(`   escrow kyc status: ${status} (1 = granted)`);
  }

  console.log("\nAdd to .env:");
  console.log(`HTLC_CONTRACT_ADDRESS=${address}`);
  console.log(`\nhashscan: ${hashscanUrl(chainId, "contract", address)}`);
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message.split("\n")[0] : err);
  process.exitCode = 1;
});
