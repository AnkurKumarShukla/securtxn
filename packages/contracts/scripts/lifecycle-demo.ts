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
//   5. a coupon is scheduled                                     -> corporate action
//   6. a payout settles through the HTLC escrow and is CLAIMED   -> receipt
//   7. an identical payout goes unclaimed and is REFUNDED        -> recovery
//   8. maturity is brought forward and the holding redeemed      -> settlement
//
// Step 2 is the point. A transfer failing on chain, for an address our own
// verification pipeline never confirmed, is the difference between a compliance
// control and a badge.
//
// Steps 6 and 7 are the other half of the argument. Step 4 already showed the
// default: a plain transfer, which lands and is never signed for. Step 6 shows
// the opt-in settlement mode where the payee must reveal a secret to be paid,
// leaving an on-chain receipt they cannot repudiate. Step 7 runs the same lock
// with nobody claiming it, and the money comes back. Together they are the
// product's premise — a payment that goes unacknowledged is recoverable (D41).
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
import { randomUUID } from "node:crypto";
import {
  BOND_LIFECYCLE_ABI,
  createAddressResolver,
  DEFAULT_PARTITION,
  hashlockFor,
  hashscanUrl,
  hederaChain,
  HtlcClient,
  KYC_ABI,
  newPreimage,
  NO_EXPIRY_SECONDS,
  PAYMENT_HTLC_ABI,
  paymentRefFor,
  ROLES,
} from "../src/index.js";

/** Anvil account #1 — the seeded payee. Its key is public; testnet only. */
const PAYEE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** Anvil account #2 — a counterparty the platform has never verified. */
const STRANGER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

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
  const asStranger = createWalletClient({ chain, transport: http(rpcUrl), account: stranger });

  const security = await createAddressResolver(required("HEDERA_MIRROR_NODE_URL")).toEvmAddress(
    required("ATS_SECURITY_ID"),
  );

  const gas = 1_000_000n;
  const confirm = async (label: string, hash: Hex): Promise<void> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    console.log(`   ${label} — ${hash}`);
  };

  /** Chain time, not local time. It is what every contract compares against. */
  const chainNow = async (): Promise<bigint> => (await publicClient.getBlock()).timestamp;

  const waitForChainTime = async (deadline: bigint, label: string): Promise<void> => {
    process.stdout.write(`   waiting for ${label}`);
    for (;;) {
      if ((await chainNow()) >= deadline) break;
      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    console.log(" reached");
  };

  /**
   * Tops up an account that has to send its own transactions.
   *
   * The counterparty only ever RECEIVED tokens up to this point, and receiving
   * an ERC-20 balance does not create a funded Hedera account. It has to claim
   * its own escrow in step 6 — that is the whole point of the receipt — so it
   * needs gas of its own. A value transfer to the address lazily creates it.
   */
  const ensureFunded = async (who: Address, label: string): Promise<void> => {
    const held = await publicClient.getBalance({ address: who });
    if (held >= 10n ** 18n) return;
    console.log(`Funding ${label} with 5 HBAR for gas`);
    const hash = await asIssuer.sendTransaction({
      to: who,
      value: 5n * 10n ** 18n,
      chain,
      account: issuer,
      // Lazy account creation costs far more than a plain transfer.
      gas: 1_500_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  /** Grants a role if the account does not already hold it. */
  const ensureRole = async (label: string, role: `0x${string}`): Promise<void> => {
    const held = await publicClient.readContract({
      address: security,
      abi: ACCESS_CONTROL_ABI,
      functionName: "hasRole",
      args: [role, issuer.address],
    });
    if (held) return;
    await confirm(
      `${label} granted`,
      await asIssuer.writeContract({
        address: security,
        abi: ACCESS_CONTROL_ABI,
        functionName: "grantRole",
        args: [role, issuer.address],
        chain,
        account: issuer,
        gas,
      }),
    );
  };

  const balance = (who: Address) =>
    publicClient.readContract({ address: security, abi: TOKEN_ABI, functionName: "balanceOf", args: [who] });
  const kyc = (who: Address) =>
    publicClient.readContract({ address: security, abi: KYC_ABI, functionName: "getKycStatusFor", args: [who] });

  // The demo must start from the same state every time — it is what the video
  // films, and a counterparty left with KYC from a previous run would make the
  // rejection in step 2 silently not happen.
  const strangerKyc = await publicClient.readContract({
    address: security,
    abi: KYC_ABI,
    functionName: "getKycStatusFor",
    args: [stranger.address],
  });
  if (Number(strangerKyc) !== 0) {
    console.log("Resetting: revoking the counterparty's KYC from a previous run");
    await ensureRole("ROLE_KYC_MANAGER", ROLES.KYC_MANAGER);
    const reset = await asIssuer.writeContract({
      address: security,
      abi: KYC_ABI,
      functionName: "revokeKyc",
      args: [stranger.address],
      chain,
      account: issuer,
      gas,
    });
    await publicClient.waitForTransactionReceipt({ hash: reset });
    console.log("");
  }

  // Step 8 leaves the bond matured. A coupon cannot be scheduled past maturity,
  // so a second run would fail at step 5 unless the horizon is pushed back out
  // first. The demo has to be re-runnable — it is what the video films.
  await ensureRole("ROLE_MATURITY_MANAGER", ROLES.MATURITY_MANAGER);
  await confirm(
    "maturity horizon reset",
    await asIssuer.writeContract({
      address: security,
      abi: BOND_LIFECYCLE_ABI,
      functionName: "updateMaturityDate",
      args: [(await chainNow()) + 3600n],
      chain,
      account: issuer,
      gas,
    }),
  );
  console.log("");

  console.log(`security : ${process.env.ATS_SECURITY_ID} (${security})`);
  console.log(`payee    : ${payee.address}  kyc=${await kyc(payee.address)}`);
  console.log(`stranger : ${stranger.address}  kyc=${await kyc(stranger.address)}  (expected 0)`);

  // --- 1. issuance ---------------------------------------------------------
  console.log("\n1. Mint 500.00 units to the verified payee");

  await ensureRole("ROLE_ISSUER", ROLES.ISSUER);

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

  // --- 5. corporate action: schedule a coupon ------------------------------
  console.log("\n5. Schedule a coupon");
  await ensureRole("ROLE_CORPORATE_ACTION", ROLES.CORPORATE_ACTION);

  const now = Math.floor(Date.now() / 1000);
  const couponsBefore = await publicClient.readContract({
    address: security,
    abi: BOND_LIFECYCLE_ABI,
    functionName: "getCouponCount",
  });

  await confirm(
    "coupon scheduled",
    await asIssuer.writeContract({
      address: security,
      abi: BOND_LIFECYCLE_ABI,
      functionName: "setCoupon",
      args: [
        {
          // Holders on the record date receive it; execution pays out after.
          recordDate: BigInt(now + 600),
          executionDate: BigInt(now + 1200),
          startDate: BigInt(now),
          endDate: BigInt(now + 1800),
          fixingDate: BigInt(now),
          rate: 250n, // 2.50%
          rateDecimals: 2,
          // RateCalculationStatus.SET (1). A STANDARD-rate bond requires the
          // rate to be SET at scheduling; PENDING (0) is for rates fixed later
          // at the fixing date, and the contract rejects it here.
          rateStatus: 1,
        },
      ],
      chain,
      account: issuer,
      gas: 2_000_000n,
    }),
  );

  const couponsAfter = await publicClient.readContract({
    address: security,
    abi: BOND_LIFECYCLE_ABI,
    functionName: "getCouponCount",
  });
  console.log(`   coupons: ${couponsBefore} -> ${couponsAfter}`);

  // --- 6. HTLC settlement, claimed -----------------------------------------
  //
  // Same payer, same payee, same token as step 4. The only thing that changes
  // is the settlement mode, which is a per-payment choice and never a
  // replacement for the plain transfer above (D41).
  console.log("\n6. Settle a payout through the HTLC escrow — the payee claims it");

  const escrowAddress = process.env.HTLC_CONTRACT_ADDRESS as Address | undefined;
  if (!escrowAddress) {
    throw new Error("HTLC_CONTRACT_ADDRESS is not set — run: pnpm --filter @cp/contracts deploy:htlc");
  }
  const htlc = new HtlcClient({ address: escrowAddress, publicClient });
  console.log(`   escrow: ${escrowAddress}`);

  // The escrow holds the security while the lock is open, so it is a holder and
  // the compliance rules apply to it too. deploy:htlc granted it KYC; without
  // that grant the lock below reverts, which is the control working, not a bug.
  console.log(`   escrow kyc: ${await kyc(escrowAddress)} (1 = granted)`);

  await ensureFunded(stranger.address, "the counterparty");

  // The secret is generated by the platform and handed to the payee out of
  // band. Only the hash goes on chain until the payee spends it.
  const preimage = newPreimage();
  const claimedRef = paymentRefFor(randomUUID());
  const claimAmount = 5_000n;

  const claimLock = await htlc.lock(asPayee, {
    paymentRef: claimedRef,
    payer: payee.address,
    payee: stranger.address,
    token: security,
    amount: claimAmount,
    hashlock: hashlockFor(preimage),
    // Generous: this branch is meant to be claimed, not to expire.
    timelock: (await chainNow()) + 900n,
  });
  console.log(`   locked ${claimAmount} — ${claimLock.lockTxHash}`);

  const afterLock = await htlc.getLock(claimLock.lockId);
  // The predicted id must match what the chain stored, or the platform would be
  // recording a lock nobody can find.
  if (afterLock.status !== "LOCKED") throw new Error(`lock id mismatch: ${claimLock.lockId}`);
  console.log(`   lock ${claimLock.lockId.slice(0, 18)}… status=${afterLock.status}`);
  console.log(`   escrow now holds: ${await balance(escrowAddress)}`);

  // A wrong secret must not open it. Without this the hashlock would be
  // decorative and the "receipt" would prove nothing.
  let wrongPreimageRejected = false;
  try {
    await publicClient.simulateContract({
      address: escrowAddress,
      abi: PAYMENT_HTLC_ABI,
      functionName: "claim",
      args: [claimLock.lockId, newPreimage()],
      account: stranger,
    });
    console.log("   UNEXPECTED: a wrong secret would open the lock");
  } catch {
    wrongPreimageRejected = true;
    console.log("   claim with a WRONG secret — REJECTED ON CHAIN");
  }

  const claimTxHash = await htlc.claim(asStranger, claimLock.lockId, preimage);
  console.log(`   claimed — ${claimTxHash}`);

  const afterClaim = await htlc.getLock(claimLock.lockId);
  // This is the acknowledgment. The secret is now public, and it was published
  // by a transaction the payee signed — the on-chain twin of the EIP-712
  // RecipientAcknowledgment the API records for direct settlement.
  const receiptValid = afterClaim.status === "CLAIMED" && afterClaim.preimage === preimage;
  console.log(`   status=${afterClaim.status}  preimage revealed on chain: ${receiptValid}`);
  console.log(`   payee    : ${await balance(payee.address)}`);
  console.log(`   recipient: ${await balance(stranger.address)}`);

  // --- 7. HTLC settlement, unclaimed and refunded --------------------------
  console.log("\n7. The same settlement, unclaimed — the money comes back");

  const refundAmount = 2_500n;
  const payeeBeforeRefundLock = await balance(payee.address);
  const refundDeadline = (await chainNow()) + 40n;

  const refundLock = await htlc.lock(asPayee, {
    paymentRef: paymentRefFor(randomUUID()),
    payer: payee.address,
    payee: stranger.address,
    token: security,
    amount: refundAmount,
    // A secret that is never handed over. This stands in for the case the whole
    // product exists for: the money went somewhere it should not have.
    hashlock: hashlockFor(newPreimage()),
    timelock: refundDeadline,
  });
  console.log(`   locked ${refundAmount} — ${refundLock.lockTxHash}`);
  console.log(`   payee now: ${await balance(payee.address)}`);

  // Refunding early must fail, or the timelock would be advisory and the payee
  // could pull funds back out from under a valid claim.
  let earlyRefundRejected = false;
  try {
    await publicClient.simulateContract({
      address: escrowAddress,
      abi: PAYMENT_HTLC_ABI,
      functionName: "refund",
      args: [refundLock.lockId],
      account: payee,
    });
    console.log("   UNEXPECTED: an early refund would succeed");
  } catch {
    earlyRefundRejected = true;
    console.log("   refund BEFORE the deadline — REJECTED ON CHAIN");
  }

  await waitForChainTime(refundDeadline, "the timelock");

  // Sent by the platform, not the payer. Anyone may trigger a refund and the
  // funds still go to the recorded payer, so recovery never depends on the
  // payer's key still being available.
  const refundTxHash = await htlc.refund(asIssuer, refundLock.lockId);
  console.log(`   refunded by the platform — ${refundTxHash}`);

  const afterRefund = await htlc.getLock(refundLock.lockId);
  const payeeAfterRefund = await balance(payee.address);
  console.log(`   status=${afterRefund.status}`);
  console.log(`   payee restored: ${payeeAfterRefund} (was ${payeeBeforeRefundLock})`);

  // --- 8. maturity and redemption ------------------------------------------
  console.log("\n8. Bring maturity forward and redeem the holding");
  await ensureRole("ROLE_MATURITY_MANAGER", ROLES.MATURITY_MANAGER);
  await ensureRole("ROLE_MATURITY_REDEEMER", ROLES.MATURITY_REDEEMER);

  // A receivable settled early is an ordinary event, and it is the only way to
  // show redemption without waiting out the original 90-day maturity.
  //
  // The date must be strictly in the FUTURE — the contract rejects a past one —
  // so it is set just ahead and then waited out. Read fresh from the chain: the
  // settlement steps above spend real seconds, and a maturity derived from a
  // timestamp taken back at step 5 would already have passed.
  const newMaturity = (await chainNow()) + 45n;
  await confirm(
    "maturity moved to +45s",
    await asIssuer.writeContract({
      address: security,
      abi: BOND_LIFECYCLE_ABI,
      functionName: "updateMaturityDate",
      args: [newMaturity],
      chain,
      account: issuer,
      gas,
    }),
  );

  await waitForChainTime(newMaturity, "maturity");

  const holdingBefore = await balance(payee.address);
  await confirm(
    "redeemed at maturity",
    await asIssuer.writeContract({
      address: security,
      abi: BOND_LIFECYCLE_ABI,
      functionName: "redeemAtMaturityByPartition",
      args: [payee.address, DEFAULT_PARTITION, holdingBefore],
      chain,
      account: issuer,
      gas: 2_000_000n,
    }),
  );

  const holdingAfter = await balance(payee.address);
  const supplyAfter = await publicClient.readContract({
    address: security,
    abi: TOKEN_ABI,
    functionName: "totalSupply",
  });
  console.log(`   payee holding: ${holdingBefore} -> ${holdingAfter}`);
  console.log(`   supply       : ${supplyAfter}`);

  // Every line below reports what was actually observed. A summary that prints
  // "yes" regardless of outcome is worse than no summary.
  console.log("\nSummary");
  console.log(`  transfer blocked before KYC : ${rejected ? "yes" : "NO — investigate"}`);
  console.log(`  transfer allowed after KYC  : yes`);
  console.log(`  coupon scheduled            : ${couponsAfter > couponsBefore ? "yes" : "NO — investigate"}`);
  console.log(`  wrong secret refused        : ${wrongPreimageRejected ? "yes" : "NO — investigate"}`);
  console.log(`  claimed, receipt on chain   : ${receiptValid ? "yes" : "NO — investigate"}`);
  console.log(`  early refund refused        : ${earlyRefundRejected ? "yes" : "NO — investigate"}`);
  console.log(
    `  unclaimed payout recovered  : ${
      afterRefund.status === "REFUNDED" && payeeAfterRefund === payeeBeforeRefundLock
        ? "yes"
        : "NO — investigate"
    }`,
  );
  console.log(`  redeemed at maturity        : ${holdingAfter < holdingBefore ? "yes" : "NO — investigate"}`);
  console.log(`  security: ${hashscanUrl(chainId, "contract", required("ATS_SECURITY_ID"))}`);
  console.log(`  escrow  : ${hashscanUrl(chainId, "contract", escrowAddress)}`);
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message.split("\n")[0] : err);
  process.exit(1);
});
