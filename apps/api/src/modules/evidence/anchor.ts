// Publishing evidence roots, and proving a record was in one.
//
// The hash chain already makes tampering detectable — for anyone who trusts our
// database. It cannot rule out our rewriting the whole chain, because the chain
// and the records it protects sit in a store we control. Anchoring closes that:
// a Merkle root on a public consensus topic is a commitment at a timestamp we
// cannot move, and after that "this record existed, unchanged, before then" is
// checkable without asking us (D19).
//
// TWO HALVES, AND THE SECOND IS THE POINT. Publishing is easy. What makes it
// worth doing is `proofFor`, which hands a verifier a leaf, a handful of
// siblings and a mirror-node URL — enough to check the claim with keccak256 and
// nothing from this system.
//
// BATCH ORDER IS PART OF THE COMMITMENT. Records are ordered by createdAt then
// id, and that ordering is re-derived from the stored anchor id when a proof is
// built later. A different order gives a different root, so the tie-break on id
// is not a detail: two records written in the same transaction share a
// timestamp, and without it a proof would sometimes fail against a root that
// was perfectly correct.
//
// Spec: docs/architecture.md §4.8

import {
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
  type MerkleProof,
} from "@cp/contracts";
import type { PrismaClient } from "@prisma/client";
import {
  AnchorMessage,
  type AnchorRunResult,
  type AnchorSummary,
  type InclusionProof,
} from "@cp/shared-types";
import type { Hex } from "viem";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import type { AnchorGateway } from "../../lib/anchor-gateway.js";

export type AnchorServiceDeps = {
  prisma: PrismaClient;
  gateway: AnchorGateway;
};

/**
 * Cap on one batch.
 *
 * Not a performance limit — a Merkle proof over ten thousand leaves is still
 * fourteen hashes. It bounds how long the first anchor after a quiet period
 * takes, so a backlog drains over several runs instead of one long one.
 */
const MAX_BATCH = 5_000;

const ALGORITHM = {
  hash: "keccak256",
  leaf: "keccak256(0x00 || payloadHash)",
  node: "keccak256(0x01 || left || right)",
  oddNode: "promoted unchanged, never duplicated",
} as const;

export class AnchorService {
  constructor(private readonly deps: AnchorServiceDeps) {}

  /**
   * Anchors every record not yet published.
   *
   * An empty batch is a success, not an error: most runs of a scheduled job
   * find nothing to do, and treating that as a failure would train whoever
   * watches the schedule to ignore it.
   */
  async run(): Promise<AnchorRunResult> {
    const pending = await this.deps.prisma.evidenceRecord.findMany({
      where: { anchorId: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_BATCH,
      select: { id: true, payloadHash: true },
    });

    if (pending.length === 0) {
      return { recordsAnchored: 0, anchor: null, broadcast: this.deps.gateway.broadcasts };
    }

    const leaves = pending.map((record) => withPrefix(record.payloadHash));
    const root = merkleRoot(leaves);

    const message = AnchorMessage.parse({
      v: 1,
      kind: "evidence-anchor",
      root,
      count: pending.length,
      submittedAt: new Date().toISOString(),
    });

    // Published BEFORE the database is touched. If this throws, nothing was
    // marked anchored and the next run retries the same batch. The reverse
    // order could mark records anchored against a message that never landed,
    // and an inclusion proof would then point at nothing.
    const receipt = await this.deps.gateway.publish(JSON.stringify(message));

    const anchor = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.evidenceAnchor.create({
        data: {
          merkleRoot: root,
          recordCount: pending.length,
          topicId: receipt.topicId,
          sequenceNumber: receipt.sequenceNumber,
          consensusTimestamp: receipt.consensusTimestamp,
          transactionId: receipt.transactionId,
          messageUrl: receipt.messageUrl ?? "",
        },
      });

      await tx.evidenceRecord.updateMany({
        where: { id: { in: pending.map((r) => r.id) } },
        // Both fields set together: the transaction id because §3 names it and
        // it is what a person pastes into an explorer, the relation because
        // rebuilding the batch for a proof needs the sibling records.
        data: { anchorId: created.id, hcsAnchorTxId: receipt.transactionId },
      });

      return created;
    });

    // Read it back before answering.
    //
    // Anchoring is not finished when we submit it — it is finished when a third
    // party can read it and the root they read matches ours. Nothing called
    // `verify` before this, so every anchor sat "unverified" forever and the
    // flag said nothing about the anchor, only that nobody had asked.
    //
    // Bounded and best-effort, deliberately. Mirror nodes lag consensus by a
    // few seconds, so a single immediate read would nearly always miss; but a
    // slow mirror must not fail an anchor that IS published, and the caller is
    // waiting on a button press. A few short attempts covers the normal case,
    // and the row stays verifiable on demand for everything else.
    const verified = await this.verifyWithRetry(anchor.id);

    return {
      recordsAnchored: pending.length,
      anchor: verified ?? toAnchorSummary(anchor),
      broadcast: this.deps.gateway.broadcasts,
    };
  }

  /**
   * Tries the read-back a few times, then gives up quietly.
   *
   * Returns null rather than throwing on anything except a ROOT MISMATCH. A
   * mirror that has not caught up is an ordinary delay; a mirror serving a
   * different root than we recorded is not, and swallowing that would hide the
   * single failure this whole mechanism exists to surface.
   */
  private async verifyWithRetry(
    anchorId: string,
    attempts = 3,
    delayMs = 2_000,
  ): Promise<AnchorSummary | null> {
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return await this.verify(anchorId);
      } catch (error) {
        // A disagreement about the root is a real finding and must not be
        // retried away. Everything else is "not there yet".
        if (error instanceof UnprocessableError) throw error;
      }
    }
    return null;
  }

  /**
   * Confirms a mirror node is serving the anchor back, and that it says what we
   * said.
   *
   * Anchoring is not finished when we submit it. It is finished when a third
   * party can read it, and the root they read matches the one we recorded. Not
   * checking would leave the difference between a real anchor and a failed
   * submission invisible on our side.
   */
  async verify(anchorId: string): Promise<AnchorSummary> {
    const anchor = await this.load(anchorId);
    if (anchor.verified) return toAnchorSummary(anchor);

    const message = await this.deps.gateway.fetch(anchor.sequenceNumber);
    if (!message) {
      throw new ConflictError(
        "The mirror node has not served this message yet; consensus propagation takes a few seconds",
      );
    }

    const published = AnchorMessage.safeParse(JSON.parse(message.contents));
    if (!published.success) {
      throw new UnprocessableError("The anchored message is not a readable evidence anchor");
    }
    if (published.data.root.toLowerCase() !== anchor.merkleRoot.toLowerCase()) {
      // Recorded as a hard failure. Our row and the public record disagreeing
      // is the one thing this whole mechanism exists to make impossible.
      throw new UnprocessableError(
        `Anchored root ${published.data.root} does not match the recorded root ${anchor.merkleRoot}`,
      );
    }

    const updated = await this.deps.prisma.evidenceAnchor.update({
      where: { id: anchorId },
      data: {
        verified: true,
        verifiedAt: new Date(),
        // The mirror node is authoritative for consensus time; the submit
        // receipt only knows when we asked.
        consensusTimestamp: message.consensusTimestamp,
      },
    });

    return toAnchorSummary(updated);
  }

  async list(limit = 50): Promise<AnchorSummary[]> {
    const rows = await this.deps.prisma.evidenceAnchor.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toAnchorSummary);
  }

  /**
   * The inclusion proof for one evidence record.
   *
   * Rebuilds the record's batch in the same order it was anchored in and walks
   * the tree. The returned proof is self-contained: leaf, siblings, root, the
   * public URL of the message the root was published in, and the algorithm.
   */
  async proofFor(evidenceRecordId: string): Promise<InclusionProof> {
    const record = await this.deps.prisma.evidenceRecord.findUnique({
      where: { id: evidenceRecordId },
      select: { id: true, paymentRequestId: true, payloadHash: true, anchorId: true },
    });
    if (!record) throw new NotFoundError(`Evidence record '${evidenceRecordId}'`);
    if (!record.anchorId) {
      throw new ConflictError(
        "This record has not been anchored yet; run POST /evidence/anchor first",
      );
    }

    const anchor = await this.load(record.anchorId);

    // The same ordering the batch was built with. Re-derived rather than
    // stored: an index column would be a second source of truth for the one
    // thing the root already commits to.
    const batch = await this.deps.prisma.evidenceRecord.findMany({
      where: { anchorId: record.anchorId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, payloadHash: true },
    });

    const index = batch.findIndex((r) => r.id === record.id);
    if (index === -1) throw new NotFoundError(`Record '${evidenceRecordId}' in its own batch`);

    const proof: MerkleProof = merkleProof(batch.map((r) => withPrefix(r.payloadHash)), index);

    // Checked before it goes out. A proof that does not verify is a bug on our
    // side, and shipping it would look like the record had been tampered with.
    if (!verifyMerkleProof(proof) || proof.root.toLowerCase() !== anchor.merkleRoot.toLowerCase()) {
      throw new UnprocessableError(
        "The rebuilt proof does not match the anchored root; the batch has changed since it was anchored",
      );
    }

    return {
      evidenceRecordId: record.id,
      paymentRequestId: record.paymentRequestId,
      leaf: proof.leaf,
      index: proof.index,
      steps: proof.steps,
      root: proof.root,
      anchor: toAnchorSummary(anchor),
      algorithm: ALGORITHM,
    };
  }

  private async load(id: string) {
    const anchor = await this.deps.prisma.evidenceAnchor.findUnique({ where: { id } });
    if (!anchor) throw new NotFoundError(`Anchor '${id}'`);
    return anchor;
  }
}

type AnchorRow = {
  id: string;
  merkleRoot: string;
  recordCount: number;
  topicId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  transactionId: string;
  messageUrl: string;
  verified: boolean;
  createdAt: Date;
};

function toAnchorSummary(row: AnchorRow): AnchorSummary {
  return {
    id: row.id,
    merkleRoot: row.merkleRoot as AnchorSummary["merkleRoot"],
    recordCount: row.recordCount,
    topicId: row.topicId,
    sequenceNumber: row.sequenceNumber,
    consensusTimestamp: row.consensusTimestamp,
    transactionId: row.transactionId,
    // Empty means nothing was published; null says that plainly rather than
    // handing a UI a link to nowhere.
    messageUrl: row.messageUrl === "" ? null : row.messageUrl,
    verified: row.verified,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Payload hashes are stored bare so genesis has the same shape as every link. */
function withPrefix(hash: string): Hex {
  return (hash.startsWith("0x") ? hash : `0x${hash}`) as Hex;
}
