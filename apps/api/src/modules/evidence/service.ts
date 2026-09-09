// Evidence chain persistence.
//
// THE RULE (D07): an evidence record is written in the SAME transaction as the
// state change it records. A record written afterwards can be lost between the
// two writes, and the chain would then claim a completeness it does not have —
// which is worse than no chain, because it reads as authoritative.
//
// Every caller therefore passes its transaction client in. There is
// deliberately no "append later" convenience method.
//
// Spec: docs/architecture.md §4.8

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  EvidencePayload,
  type EvidenceChainResponse,
  type EvidenceEventType,
} from "@cp/shared-types";
import { NotFoundError } from "../../lib/errors.js";
import { GENESIS_PREVIOUS_HASH, computeRecordHash, verifyChain } from "./chain.js";

/** Anything that can run a query: the client, or a transaction handle. */
export type TxClient = Pick<PrismaClient, "evidenceRecord">;

const MAX_APPEND_ATTEMPTS = 3;

export class EvidenceService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Appends one record to a payment's chain.
   *
   * `tx` must be the transaction doing the state change. Passing the bare
   * client works mechanically and is exactly the mistake this signature exists
   * to make visible in review.
   */
  async append(tx: TxClient, payload: EvidencePayload): Promise<{ payloadHash: string }> {
    // Parse, do not trust. A payload that fails its schema is never written,
    // which is what keeps the chain readable months later (D27).
    const validated = EvidencePayload.parse(payload);

    const tip = await tx.evidenceRecord.findFirst({
      where: { paymentRequestId: validated.paymentRequestId },
      orderBy: { createdAt: "desc" },
    });

    const previousRecordHash = tip?.payloadHash ?? GENESIS_PREVIOUS_HASH;
    const payloadHash = computeRecordHash(validated, previousRecordHash);

    await tx.evidenceRecord.create({
      data: {
        paymentRequestId: validated.paymentRequestId,
        eventType: validated.eventType,
        payload: validated as unknown as Prisma.InputJsonValue,
        payloadHash,
        previousRecordHash,
      },
    });

    return { payloadHash };
  }

  /**
   * Appends outside any caller transaction, retrying on a fork collision.
   *
   * Only for records that are not tied to a state change — currently just the
   * access audit. Two concurrent readers can both see the same tip and race;
   * the unique constraint on (paymentRequestId, previousRecordHash) rejects the
   * loser (D25), and retrying re-reads the new tip.
   */
  async appendStandalone(payload: EvidencePayload): Promise<void> {
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      try {
        await this.prisma.$transaction((tx) => this.append(tx, payload));
        return;
      } catch (err) {
        const isFork =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!isFork || attempt === MAX_APPEND_ATTEMPTS) throw err;
      }
    }
  }

  /**
   * Returns the chain and verifies it, recomputing from genesis on every read
   * rather than trusting a stored flag.
   */
  async getChain(paymentRequestId: string): Promise<EvidenceChainResponse> {
    const payment = await this.prisma.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      select: { id: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentRequestId}'`);

    const records = await this.prisma.evidenceRecord.findMany({
      where: { paymentRequestId },
      orderBy: { createdAt: "asc" },
    });

    const verification = verifyChain(
      records.map((r) => ({
        payload: r.payload,
        payloadHash: r.payloadHash,
        previousRecordHash: r.previousRecordHash,
      })),
    );

    return {
      paymentRequestId,
      records: records.map((r) => ({
        id: r.id,
        eventType: r.eventType as EvidenceEventType,
        payload: r.payload,
        payloadHash: r.payloadHash,
        previousRecordHash: r.previousRecordHash,
        hcsAnchorTxId: r.hcsAnchorTxId,
        createdAt: r.createdAt.toISOString(),
      })),
      chainValid: verification.chainValid,
      brokenAtIndex: verification.brokenAtIndex,
    };
  }

  /**
   * Records that someone read the trail.
   *
   * Appended AFTER the response is built, so the returned chain reflects state
   * as of the read rather than including the record describing that same read
   * (D18).
   */
  async recordAccess(input: {
    paymentRequestId: string;
    actorId: string;
    actorRole: string;
  }): Promise<void> {
    await this.appendStandalone({
      eventType: "evidence_accessed",
      paymentRequestId: input.paymentRequestId,
      timestamp: new Date().toISOString(),
      data: { actorId: input.actorId, actorRole: input.actorRole },
    });
  }
}
