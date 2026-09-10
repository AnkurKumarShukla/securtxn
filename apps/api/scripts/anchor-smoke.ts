// Anchors real evidence to the real consensus topic, once, and checks it back.
//
//   pnpm --filter @cp/api smoke:anchor
//
// A script rather than a test, for the same reason as the chain smoke: it
// writes to the real audit topic, and a topic with test roots interleaved among
// real ones is worse than one with gaps.
//
// It proves the only thing the mocked suite cannot — that somebody else is
// holding the message. The last step re-derives the root from the proof and
// compares it against what a PUBLIC mirror node serves, with no credentials and
// no help from this API.
//
// Spec: docs/architecture.md §4.8

import { hashLeaf, hashNode, messageUrl } from "@cp/contracts";
import { Prisma, PrismaClient } from "@prisma/client";
import type { Hex } from "viem";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";
import { EvidenceService } from "../src/modules/evidence/service.js";

const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function main(): Promise<void> {
  const base = loadConfig();

  const config: Config = {
    ...base,
    NODE_ENV: "development",
    isProduction: false,
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    COMPLIANCE_GATEWAY: "mock",
    CHAIN_GATEWAY: "mock",
    // The one live thing here.
    ANCHOR_GATEWAY: "hcs",
  };

  if (!config.HCS_TOPIC_ID) {
    throw new Error("HCS_TOPIC_ID is not set; run: pnpm --filter @cp/contracts create:topic");
  }

  const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
  const app = await buildServer(config);
  await app.ready();

  const gateway = app.container.anchorGateway;
  if (!gateway.broadcasts) {
    throw new Error("anchor gateway resolved to mock; check ANCHOR_GATEWAY and the Hedera config");
  }

  const token = await app.signToken("agent", "anchor-smoke");
  const auth = { authorization: `Bearer ${token}` };
  const created: { vendorId?: string; paymentId?: string } = {};

  console.log(`topic : ${gateway.topicId}`);

  try {
    // --- 1. real evidence to anchor ----------------------------------------
    const vendor = await prisma.vendor.create({
      data: {
        payeeType: "BUSINESS",
        legalEntityName: "Anchor Smoke Traders Private Limited",
        country: "IN",
        verificationTier: "TIER2_IDENTITY",
      },
    });
    created.vendorId = vendor.id;

    const wallet = await prisma.vendorWallet.create({
      data: {
        vendorId: vendor.id,
        address: PAYEE,
        network: "hedera",
        version: 1,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    });

    const payment = await prisma.paymentRequest.create({
      data: {
        vendorId: vendor.id,
        vendorWalletId: wallet.id,
        invoiceRef: `ANCHOR-${Date.now()}`,
        amount: new Prisma.Decimal("500.00"),
        token: "USDC",
        network: "hedera",
        senderContextCommitment: `0x${"ab".repeat(32)}`,
        status: "DRAFT",
      },
    });
    created.paymentId = payment.id;

    const evidence = new EvidenceService(prisma);
    await evidence.append(prisma, {
      eventType: "vendor_match",
      paymentRequestId: payment.id,
      timestamp: new Date().toISOString(),
      data: { matched: true, score: 0.97, reasonCode: "NAME_MATCH", matcher: "fallback" },
    });
    await evidence.append(prisma, {
      eventType: "decision",
      paymentRequestId: payment.id,
      timestamp: new Date().toISOString(),
      data: {
        decision: "SAFE_TO_SEND",
        reasonCode: "ALL_CHECKS_PASSED",
        matchScore: 0.97,
        tierLimitApplied: null,
      },
    });

    const records = await prisma.evidenceRecord.findMany({
      where: { paymentRequestId: payment.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });

    // --- 2. publish ---------------------------------------------------------
    console.log("\n1. POST /evidence/anchor");
    const run = await app.inject({ method: "POST", url: "/evidence/anchor", headers: auth });
    expect(run.statusCode === 200, `anchor failed: ${run.body}`);

    const anchor = run.json().anchor;
    expect(anchor !== null, "nothing was anchored; the batch was empty");
    expect(run.json().broadcast === true, "anchor reported broadcast:false on a live gateway");

    console.log(`   ${run.json().recordsAnchored} records`);
    console.log(`   root  ${anchor.merkleRoot}`);
    console.log(`   seq   ${anchor.sequenceNumber}`);
    console.log(`   tx    ${anchor.transactionId}`);

    // --- 3. wait for the mirror node ---------------------------------------
    // Consensus is immediate; mirror node propagation is not. Polling here is
    // the honest representation of that gap.
    console.log("\n2. POST /evidence/anchors/:id/verify");
    process.stdout.write("   waiting for the mirror node");
    let verified: unknown = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: `/evidence/anchors/${anchor.id}/verify`,
        headers: auth,
      });
      if (response.statusCode === 200) {
        verified = response.json();
        break;
      }
      if (response.statusCode !== 409) throw new Error(`verify failed: ${response.body}`);
      process.stdout.write(".");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    console.log(verified ? " served" : " TIMED OUT");
    expect(verified !== null, "the mirror node never served the message back");

    // --- 4. the inclusion proof --------------------------------------------
    console.log("\n3. GET /evidence/records/:id/proof");
    const proofResponse = await app.inject({
      method: "GET",
      url: `/evidence/records/${records[0]!.id}/proof`,
      headers: auth,
    });
    expect(proofResponse.statusCode === 200, `proof failed: ${proofResponse.body}`);
    const proof = proofResponse.json();
    console.log(`   leaf  ${proof.leaf}`);
    console.log(`   steps ${proof.steps.length}`);

    // Recomputed here by following the algorithm the response states, not by
    // calling our own verifier. This is what an outside party would run.
    let running = hashLeaf(proof.leaf as Hex);
    for (const step of proof.steps) {
      running =
        step.position === "left"
          ? hashNode(step.hash as Hex, running)
          : hashNode(running, step.hash as Hex);
    }
    expect(running === proof.root, "the recomputed root does not match the proof's root");

    // --- 5. the independent check ------------------------------------------
    // No credentials, no API. Just the public mirror node and the root.
    console.log("\n4. Read the root back from the public mirror node");
    const url = messageUrl(config.HEDERA_MIRROR_NODE_URL!, anchor.topicId, anchor.sequenceNumber);
    const published = (await (await fetch(url)).json()) as {
      messages: { message: string; consensus_timestamp: string; payer_account_id: string }[];
    };
    const contents = Buffer.from(published.messages[0]!.message, "base64").toString("utf8");
    const onChain = JSON.parse(contents) as { root: string; count: number };

    console.log(`   ${url}`);
    console.log(`   consensus ${published.messages[0]!.consensus_timestamp}`);
    console.log(`   payer     ${published.messages[0]!.payer_account_id}`);

    expect(
      onChain.root.toLowerCase() === running.toLowerCase(),
      `published root ${onChain.root} does not match the recomputed ${running}`,
    );

    const chainId = config.HEDERA_CHAIN_ID;
    console.log("\nSummary");
    console.log(`  records anchored          : ${run.json().recordsAnchored}`);
    console.log(`  mirror node served it     : yes`);
    console.log(`  proof recomputes the root : yes`);
    console.log(`  public root == our root   : yes`);
    console.log(
      `  hashscan: https://hashscan.io/${chainId === 295 ? "mainnet" : "testnet"}/topic/${anchor.topicId}`,
    );
  } finally {
    // The rows go; the anchored root stays on the topic, which is the point.
    if (created.paymentId) {
      await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: created.paymentId } });
      await prisma.paymentRequest.deleteMany({ where: { id: created.paymentId } });
    }
    if (created.vendorId) {
      await prisma.vendorWallet.deleteMany({ where: { vendorId: created.vendorId } });
      await prisma.vendor.deleteMany({ where: { id: created.vendorId } });
    }
    await app.close();
    await prisma.$disconnect();
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

main().catch((err: unknown) => {
  console.error("\nFailed:", err instanceof Error ? err.message.split("\n")[0] : err);
  process.exitCode = 1;
});
