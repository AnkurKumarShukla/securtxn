// Evidence anchoring, through HTTP, against the mock consensus gateway.
//
// The mock keeps the messages it was given, so the round trip — publish, read
// back, mark verified — is exercised without a network. What it cannot
// simulate is the property that matters, that somebody else holds the message;
// that is proven once, live, by the smoke script.
//
// Spec: docs/architecture.md §4.8

import { verifyMerkleProof, hashLeaf, hashNode } from "@cp/contracts";
import { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";

const base = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: base.DATABASE_URL } } });

let app: FastifyInstance;
let token: string;
let vendorId: string;
let walletId: string;
const paymentIds: string[] = [];

const auth = () => ({ authorization: `Bearer ${token}` });
const post = (url: string) => app.inject({ method: "POST", url, headers: auth() });
const get = (url: string) => app.inject({ method: "GET", url, headers: auth() });

beforeAll(async () => {
  const config: Config = {
    ...base,
    NODE_ENV: "test",
    isProduction: false,
    // Pinned, not inherited. The deployed default is `cre`, and letting the
    // suite pick that up would drive every test through a live DON and a
    // public tunnel — slow, flaky, and dependent on a Vault secret that
    // expires. The fallback exists precisely so the tests do not need an
    // enclave (D09), and one shared contract suite proves the two agree.
    VENDOR_MATCHER: "fallback",
    RATE_LIMIT_MAX: 1_000_000,
    IDENTITY_PROVIDER: "mock",
    COMPLIANCE_GATEWAY: "mock",
    CHAIN_GATEWAY: "mock",
    ANCHOR_GATEWAY: "mock",
  };
  app = await buildServer(config);
  await app.ready();
  token = await app.signToken("agent", "anchor-test");

  const vendor = await prisma.vendor.create({
    data: {
      payeeType: "BUSINESS",
      legalEntityName: "Anchor Test Trading Private Limited",
      country: "IN",
      verificationTier: "TIER2_IDENTITY",
    },
  });
  vendorId = vendor.id;

  walletId = (
    await prisma.vendorWallet.create({
      data: {
        vendorId,
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        network: "hedera",
        version: 1,
        status: "CONFIRMED",
        confirmedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.evidenceRecord.deleteMany({ where: { paymentRequestId: { in: paymentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { id: { in: paymentIds } } });
  await prisma.vendorWallet.deleteMany({ where: { vendorId } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
  // Anchors created by these runs. Left behind they would be swept into a
  // later suite's batch and make its record counts unpredictable.
  //
  // Release the records first. The anchoring job sweeps EVERY unanchored
  // record, not just this suite's, so a batch here can end up owning evidence
  // belonging to another suite's payment — and deleting the anchor then trips
  // EvidenceRecord_anchorId_fkey. Detaching is right rather than cascading:
  // those records are still valid evidence, they simply are not anchored any
  // more, which is the true state once the anchor is gone.
  const mockAnchors = await prisma.evidenceAnchor.findMany({
    where: { topicId: "0.0.0" },
    select: { id: true },
  });
  await prisma.evidenceRecord.updateMany({
    where: { anchorId: { in: mockAnchors.map((a) => a.id) } },
    data: { anchorId: null, hcsAnchorTxId: null },
  });
  await prisma.evidenceAnchor.deleteMany({ where: { topicId: "0.0.0" } });
  await app?.close();
  await prisma.$disconnect();
});

/**
 * Drains anything an earlier suite left unanchored.
 *
 * The anchoring job is global by design — it takes every unanchored record,
 * not just this test's. Draining first is what makes a batch size assertable.
 */
beforeEach(async () => {
  await post("/evidence/anchor");
});

/** A payment carrying `count` evidence records. */
async function paymentWithEvidence(count: number): Promise<{ paymentId: string; recordIds: string[] }> {
  const payment = await prisma.paymentRequest.create({
    data: {
      vendorId,
      vendorWalletId: walletId,
      invoiceRef: `INV-${Math.random().toString(36).slice(2, 10)}`,
      amount: new Prisma.Decimal("100.00"),
      token: "USDC",
      network: "hedera",
      senderContextCommitment: `0x${"11".repeat(32)}`,
      status: "DRAFT",
    },
  });
  paymentIds.push(payment.id);

  const service = new (await import("../src/modules/evidence/service.js")).EvidenceService(prisma);
  for (let i = 0; i < count; i += 1) {
    await service.append(prisma, {
      eventType: "vendor_match",
      paymentRequestId: payment.id,
      timestamp: new Date().toISOString(),
      data: { matched: true, score: 0.9, reasonCode: `R${i}`, matcher: "fallback" },
    });
  }

  const records = await prisma.evidenceRecord.findMany({
    where: { paymentRequestId: payment.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return { paymentId: payment.id, recordIds: records.map((r) => r.id) };
}

describe("running the anchoring job", () => {
  it("treats an empty batch as a success", async () => {
    const response = await post("/evidence/anchor");
    expect(response.statusCode).toBe(200);
    // Most runs of a scheduled job find nothing. Reporting that as a failure
    // trains whoever watches the schedule to ignore it.
    expect(response.json().recordsAnchored).toBe(0);
    expect(response.json().anchor).toBeNull();
  });

  it("publishes a root over every unanchored record", async () => {
    const { recordIds } = await paymentWithEvidence(4);

    const response = await post("/evidence/anchor");
    expect(response.statusCode).toBe(200);
    expect(response.json().recordsAnchored).toBe(4);

    const anchor = response.json().anchor;
    expect(anchor.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(anchor.recordCount).toBe(4);
    // Mocked, so nothing was published and the response says so rather than
    // handing a UI a link to nowhere (D21).
    expect(response.json().broadcast).toBe(false);
    expect(anchor.messageUrl).toBeNull();

    const records = await prisma.evidenceRecord.findMany({
      where: { id: { in: recordIds } },
      select: { anchorId: true, hcsAnchorTxId: true },
    });
    // Both fields set together: the id for a person to paste into an explorer,
    // the relation so a proof can rebuild the batch.
    expect(records.every((r) => r.anchorId === anchor.id)).toBe(true);
    expect(records.every((r) => r.hcsAnchorTxId === anchor.transactionId)).toBe(true);
  });

  it("does not anchor the same record twice", async () => {
    await paymentWithEvidence(3);
    expect((await post("/evidence/anchor")).json().recordsAnchored).toBe(3);
    expect((await post("/evidence/anchor")).json().recordsAnchored).toBe(0);
  });

  it("lists anchors newest first", async () => {
    await paymentWithEvidence(2);
    const first = (await post("/evidence/anchor")).json().anchor;
    await paymentWithEvidence(2);
    const second = (await post("/evidence/anchor")).json().anchor;

    const listed = (await get("/evidence/anchors?limit=2")).json();
    expect(listed[0].id).toBe(second.id);
    expect(listed[1].id).toBe(first.id);
  });
});

describe("verifying an anchor", () => {
  it("marks it verified once the message reads back", async () => {
    await paymentWithEvidence(2);
    const anchor = (await post("/evidence/anchor")).json().anchor;
    expect(anchor.verified).toBe(false);

    const verified = await post(`/evidence/anchors/${anchor.id}/verify`);
    expect(verified.statusCode).toBe(200);
    // Anchoring is finished when a third party can read it back, not when we
    // submitted it.
    expect(verified.json().verified).toBe(true);
  });

  it("is idempotent", async () => {
    await paymentWithEvidence(2);
    const anchor = (await post("/evidence/anchor")).json().anchor;
    await post(`/evidence/anchors/${anchor.id}/verify`);
    expect((await post(`/evidence/anchors/${anchor.id}/verify`)).statusCode).toBe(200);
  });

  it("404s for an anchor that does not exist", async () => {
    const response = await post("/evidence/anchors/11111111-2222-4333-8444-555555555555/verify");
    expect(response.statusCode).toBe(404);
  });
});

describe("inclusion proofs", () => {
  it("proves every record in a batch, and each proof verifies standalone", async () => {
    const { recordIds } = await paymentWithEvidence(5);
    const anchor = (await post("/evidence/anchor")).json().anchor;

    for (const [index, recordId] of recordIds.entries()) {
      const response = await get(`/evidence/records/${recordId}/proof`);
      expect(response.statusCode).toBe(200);

      const proof = response.json();
      expect(proof.index).toBe(index);
      expect(proof.root).toBe(anchor.merkleRoot);
      expect(proof.anchor.id).toBe(anchor.id);

      // Verified with the library rather than by trusting the endpoint. This
      // is exactly what an outside party would run.
      expect(
        verifyMerkleProof({
          leaf: proof.leaf as Hex,
          index: proof.index,
          steps: proof.steps,
          root: proof.root as Hex,
        }),
      ).toBe(true);
    }
  });

  it("carries the leaf that is the record's own payload hash", async () => {
    const { recordIds } = await paymentWithEvidence(3);
    await post("/evidence/anchor");

    const recordId = recordIds[1]!;
    const record = await prisma.evidenceRecord.findUniqueOrThrow({ where: { id: recordId } });
    const proof = (await get(`/evidence/records/${recordId}/proof`)).json();

    // The chain and the tree commit to the same bytes; if they ever diverged, a
    // proof would attest to something the chain never recorded.
    expect(proof.leaf).toBe(`0x${record.payloadHash}`);
  });

  it("states the algorithm in the response", async () => {
    const { recordIds } = await paymentWithEvidence(2);
    await post("/evidence/anchor");
    const proof = (await get(`/evidence/records/${recordIds[0]}/proof`)).json();

    // Written into the response rather than into documentation someone has to
    // find. A verifier reimplementing this needs the prefixes and the odd-node
    // rule, and getting either wrong silently fails.
    expect(proof.algorithm.leaf).toBe("keccak256(0x00 || payloadHash)");
    expect(proof.algorithm.node).toBe("keccak256(0x01 || left || right)");
    expect(proof.algorithm.oddNode).toBe("promoted unchanged, never duplicated");
  });

  it("can be recomputed by hand from the published rules", async () => {
    const { recordIds } = await paymentWithEvidence(2);
    await post("/evidence/anchor");
    const proof = (await get(`/evidence/records/${recordIds[0]}/proof`)).json();

    // The independent check: follow the stated algorithm, ignore our verifier.
    let running = hashLeaf(proof.leaf as Hex);
    for (const step of proof.steps) {
      running =
        step.position === "left"
          ? hashNode(step.hash as Hex, running)
          : hashNode(running, step.hash as Hex);
    }
    expect(running).toBe(proof.root);
  });

  it("refuses a proof for a record that has not been anchored", async () => {
    const { recordIds } = await paymentWithEvidence(2);
    const response = await get(`/evidence/records/${recordIds[0]}/proof`);
    expect(response.statusCode).toBe(409);
  });

  it("404s for a record that does not exist", async () => {
    const response = await get("/evidence/records/11111111-2222-4333-8444-555555555555/proof");
    expect(response.statusCode).toBe(404);
  });

  it("stops matching if the record is altered after anchoring", async () => {
    const { recordIds } = await paymentWithEvidence(3);
    await post("/evidence/anchor");
    const recordId = recordIds[0]!;

    const before = (await get(`/evidence/records/${recordId}/proof`)).json();

    // Someone edits a record in our own database, after the root is public.
    await prisma.evidenceRecord.update({
      where: { id: recordId },
      data: { payloadHash: "f".repeat(64) },
    });

    const after = await get(`/evidence/records/${recordId}/proof`);
    // The rebuilt tree no longer produces the anchored root, and the service
    // refuses to hand out a proof it knows is wrong rather than shipping one
    // that fails silently for the verifier.
    expect(after.statusCode).toBe(422);
    expect(before.root).not.toBe("f".repeat(64));
  });
});
