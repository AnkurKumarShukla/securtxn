// Drives the real HTTP routes against Hedera testnet, once, end to end.
//
//   pnpm --filter @cp/api smoke:chain
//
// WHY THIS IS A SCRIPT AND NOT A TEST. It deploys a bond, mints, schedules a
// coupon, redeems, opens an escrow and claims it — all with real gas. A suite
// that did this on every run would be a suite nobody dares run, and one bad
// merge from an expensive accident. Everything here is covered by mocked tests;
// this exists to prove the mock is not lying about the shape of the real thing.
//
// It answers exactly one question: does a consumer UI calling these endpoints
// actually move a real chain? Every call below goes through app.inject, so the
// route, its schema, its role guard and its service all run for real. The only
// shortcut is the KYC grant, which uses the compliance gateway directly rather
// than driving a full DigiLocker onboarding for a smoke test.
//
// Spec: docs/architecture.md §4.5

import { HtlcClient, hederaChain } from "@cp/contracts";
import { PrismaClient } from "@prisma/client";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { SECRET_RELEASE_TYPES, buildSecretReleaseMessage, domainFor } from "../src/lib/eip712.js";

/** Anvil account #1. Public key, testnet only — it plays the supplier here. */
const PAYEE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function main(): Promise<void> {
  const base = loadConfig();

  const config: Config = {
    ...base,
    NODE_ENV: "development",
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    // Both live. This is the run that proves the routes reach the chain.
    CHAIN_GATEWAY: "hedera",
    COMPLIANCE_GATEWAY: "ats",
  };

  for (const key of ["ATS_ISSUER_PRIVATE_KEY", "HEDERA_JSON_RPC_URL", "HEDERA_MIRROR_NODE_URL"]) {
    if (!config[key as keyof Config]) throw new Error(`${key} is not set`);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
  const app = await buildServer(config);
  await app.ready();

  const chain = app.container.chainGateway;
  if (!chain.broadcasts) throw new Error("chain gateway resolved to mock; check the Hedera config");

  const issuerToken = await app.signToken("issuer", "live-smoke");
  const approverToken = await app.signToken("approver", "live-smoke");
  const agentToken = await app.signToken("agent", "live-smoke");
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const payee = privateKeyToAccount(PAYEE_KEY);
  const created: { vendorId?: string; walletId?: string; paymentId?: string } = {};

  console.log(`issuer   : ${chain.issuerAddress}`);
  console.log(`treasury : ${chain.treasuryAddress}`);
  console.log(`payee    : ${payee.address}`);

  try {
    // --- 1. a vendor with a confirmed payout address -----------------------
    const vendor = await prisma.vendor.create({
      data: {
        payeeType: "BUSINESS",
        legalEntityName: "Live Smoke Supplies Private Limited",
        country: "IN",
        verificationTier: "TIER2_IDENTITY",
      },
    });
    created.vendorId = vendor.id;

    const wallet = await prisma.vendorWallet.create({
      data: {
        vendorId: vendor.id,
        address: payee.address,
        network: "hedera",
        version: 1,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    });
    created.walletId = wallet.id;

    // --- 2. issue -----------------------------------------------------------
    console.log("\n1. POST /securities");
    const issued = await app.inject({
      method: "POST",
      url: "/securities",
      headers: auth(issuerToken),
      payload: {
        name: "Live Smoke Receivable",
        symbol: `SMK${Date.now() % 100000}`,
        nominalValue: "100.00",
        maxSupply: "10000.00",
        maturityDate: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      },
    });
    expect(issued.statusCode === 201, `issue failed: ${issued.body}`);

    const security = issued.json();
    const token = security.evmAddress as Address;
    console.log(`   ${security.symbol} at ${token}`);
    console.log(`   ${security.explorerUrl}`);

    // --- 3. KYC for everyone who will hold it -------------------------------
    // The escrow included: it holds the security while a lock is open, so the
    // compliance rules apply to it exactly as they do to a person.
    console.log("\n2. Grant KYC to the payee, the treasury and the escrow");
    for (const [label, address] of [
      ["payee", payee.address],
      ["treasury", chain.treasuryAddress],
      ["escrow", config.HTLC_CONTRACT_ADDRESS],
    ] as const) {
      if (!address) continue;
      const result = await app.container.complianceGateway.grantKyc({
        securityId: token,
        account: address,
        vcId: `live-smoke-${label}`,
        validFrom: new Date(),
        validTo: null,
      });
      console.log(`   ${label.padEnd(9)} ${result.broadcast ? result.txHash : "not broadcast"}`);
    }

    // --- 4. mint ------------------------------------------------------------
    console.log("\n3. POST /securities/:id/mint (treasury, to fund the payout)");
    const minted = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/mint`,
      headers: auth(issuerToken),
      payload: { toTreasury: true, amount: "1000.00" },
    });
    expect(minted.statusCode === 201, `mint failed: ${minted.body}`);
    expect(minted.json().broadcast === true, "mint reported broadcast:false on a live gateway");
    console.log(`   ${minted.json().txHash}`);

    // --- 5. corporate action ------------------------------------------------
    console.log("\n4. POST /securities/:id/coupon");
    const coupon = await app.inject({
      method: "POST",
      url: `/securities/${security.id}/coupon`,
      headers: auth(issuerToken),
      payload: {
        recordDate: new Date(Date.now() + 600_000).toISOString(),
        executionDate: new Date(Date.now() + 1_200_000).toISOString(),
        rate: "2.50",
      },
    });
    expect(coupon.statusCode === 201, `coupon failed: ${coupon.body}`);
    console.log(`   ${coupon.json().txHash}`);

    // --- 6. settle through the escrow --------------------------------------
    console.log("\n5. POST /payments/:id/settle (HTLC)");
    const payment = await prisma.paymentRequest.create({
      data: {
        vendorId: vendor.id,
        vendorWalletId: wallet.id,
        invoiceRef: `SMOKE-${Date.now()}`,
        amount: new (await import("@prisma/client")).Prisma.Decimal("25.00"),
        token: security.symbol,
        network: "hedera",
        settlementMode: "HTLC",
        senderContextCommitment: `0x${"ef".repeat(32)}`,
        status: "AWAITING_APPROVAL",
        decision: "SAFE_TO_SEND",
        decisionReasonCode: "ALL_CHECKS_PASSED",
      },
    });
    created.paymentId = payment.id;
    // The wallet names the token, so settlement does not have to guess which
    // contract the symbol refers to.
    await prisma.vendorWallet.update({ where: { id: wallet.id }, data: { tokenContract: token } });

    const settled = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/settle`,
      headers: auth(approverToken),
      payload: { timelockSeconds: 900 },
    });
    expect(settled.statusCode === 200, `settle failed: ${settled.body}`);
    const settlement = settled.json().settlement;
    console.log(`   locked ${settlement.onChainAmount} — ${settlement.lockTxHash}`);
    console.log(`   lock ${settlement.lockId}`);

    // --- 7. the payee proves the address is theirs, and gets the secret -----
    console.log("\n6. POST /payments/:id/settlement/secret");
    const signature = await payee.signTypedData({
      domain: domainFor(config.HEDERA_CHAIN_ID),
      types: SECRET_RELEASE_TYPES,
      primaryType: "SecretRelease",
      message: buildSecretReleaseMessage({
        paymentRequestId: payment.id,
        recipientAddress: payee.address,
        lockId: settlement.lockId,
      }),
    });

    const released = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/settlement/secret`,
      headers: auth(agentToken),
      payload: { signature },
    });
    expect(released.statusCode === 200, `secret release failed: ${released.body}`);
    console.log("   secret released to the payee");

    // --- 8. the payee claims, from their own key ---------------------------
    // Not through the API: the claim has to be signed by the payee, and that is
    // the whole reason it counts as a receipt (D41).
    console.log("\n7. Payee claims on chain, then reports it");
    const hederaChainDef = hederaChain(config.HEDERA_CHAIN_ID, config.HEDERA_JSON_RPC_URL!);
    const publicClient = createPublicClient({
      chain: hederaChainDef,
      transport: http(config.HEDERA_JSON_RPC_URL!),
    });
    const payeeWallet = createWalletClient({
      chain: hederaChainDef,
      transport: http(config.HEDERA_JSON_RPC_URL!),
      account: payee,
    });

    const htlc = new HtlcClient({
      address: config.HTLC_CONTRACT_ADDRESS as Address,
      publicClient,
    });
    const claimTxHash = await htlc.claim(
      payeeWallet,
      settlement.lockId as Hex,
      released.json().preimage as Hex,
    );
    console.log(`   claimed — ${claimTxHash}`);

    const recorded = await app.inject({
      method: "POST",
      url: `/payments/${payment.id}/settlement/claim`,
      headers: auth(agentToken),
      payload: { preimage: released.json().preimage, claimTxHash },
    });
    expect(recorded.statusCode === 200, `claim record failed: ${recorded.body}`);
    expect(recorded.json().status === "CLAIMED", "escrow did not reach CLAIMED");

    const ack = await prisma.recipientAcknowledgment.findUnique({
      where: { paymentRequestId: payment.id },
    });

    // --- 9. what actually happened ------------------------------------------
    console.log("\nSummary");
    console.log(`  security issued via API     : ${security.explorerUrl}`);
    console.log(`  minted, broadcast           : ${minted.json().broadcast ? "yes" : "NO"}`);
    console.log(`  coupon scheduled            : ${coupon.statusCode === 201 ? "yes" : "NO"}`);
    console.log(`  escrow opened via API       : ${settlement.lockTxHash}`);
    console.log(`  payee claimed with a secret : ${claimTxHash}`);
    console.log(`  acknowledgment recorded     : ${ack ? ack.method : "NO — investigate"}`);
    console.log(`  payee balance               : ${await chain.balanceOf(token, payee.address)}`);
  } finally {
    // The rows are throwaway; the chain state is not, and stays as evidence.
    if (created.paymentId) {
      await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: created.paymentId } });
      await prisma.recipientAcknowledgment.deleteMany({
        where: { paymentRequestId: created.paymentId },
      });
      const settlements = await prisma.htlcSettlement.findMany({
        where: { paymentRequestId: created.paymentId },
        select: { preimageEncryptedRef: true },
      });
      await prisma.htlcSettlement.deleteMany({ where: { paymentRequestId: created.paymentId } });
      await prisma.approvalEvent.deleteMany({ where: { paymentRequestId: created.paymentId } });
      await prisma.paymentRequest.deleteMany({ where: { id: created.paymentId } });
      await prisma.encryptedBlob.deleteMany({
        where: {
          id: {
            in: settlements
              .map((s) => s.preimageEncryptedRef)
              .filter((id): id is string => Boolean(id)),
          },
        },
      });
    }
    if (created.vendorId) {
      await prisma.vendorWallet.deleteMany({ where: { vendorId: created.vendorId } });
      await prisma.vendor.deleteMany({ where: { id: created.vendorId } });
    }
    await app.close();
    await prisma.$disconnect();
  }
}

/** Fails loudly and immediately. A smoke test that limps on proves nothing. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message.split("\n").slice(0, 3).join(" | ") : err);
  process.exitCode = 1;
});
