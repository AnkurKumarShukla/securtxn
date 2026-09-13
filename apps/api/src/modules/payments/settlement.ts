// HTLC settlement: recording what the escrow did.
//
// THIS SERVICE BROADCASTS NOTHING. The bridge holds the only key and sends the
// approve, lock, claim and refund transactions; this records them afterwards,
// exactly as a direct send is recorded (D12, D32). Every method here therefore
// describes something that has already happened on chain.
//
// What it does do is CHECK. A reported lock has its id re-derived from the
// parameters, and a reported claim has its preimage hashed against the stored
// hashlock. Neither is a formality: a lock recorded under an id the chain never
// issued is money the platform cannot find again, and a claim accepted without
// the hash check would be a receipt that proves nothing (D41).
//
// Spec: docs/architecture.md §4.5, §4.8

import { computeLockId, paymentRefFor } from "@cp/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  RecordClaimRequest,
  RecordLockRequest,
  RecordRefundRequest,
  SettlementSummary,
} from "@cp/shared-types";
import { keccak256, type Address, type Hex } from "viem";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import type { EvidenceService } from "../evidence/service.js";
import type { ExceptionService } from "../exceptions/service.js";

export type SettlementServiceDeps = {
  prisma: PrismaClient;
  evidence: EvidenceService;
  exceptions: ExceptionService;
};

export class SettlementService {
  constructor(private readonly deps: SettlementServiceDeps) {}

  /**
   * Records an escrow the bridge has already opened.
   *
   * Requires the payment to have been sent: the lock transaction IS the send,
   * so a lock reported against a payment nobody approved would mean funds moved
   * outside the approval path.
   */
  async recordLock(paymentId: string, input: RecordLockRequest): Promise<SettlementSummary> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: paymentId },
      include: { vendorWallet: true, htlcSettlement: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);

    if (payment.settlementMode !== "HTLC") {
      throw new UnprocessableError(
        `Payment settles as '${payment.settlementMode}'; an escrow cannot be recorded against it`,
      );
    }
    // APPROVED is the payer-funded case: the platform authorised the escrow and
    // prepared it, and the payer has now funded it from their own wallet. SENT
    // and CONFIRMED_ON_CHAIN are the treasury case, where the broadcast has
    // already happened and this endpoint is only recording it.
    const prepared = payment.htlcSettlement;
    const payerFunded = prepared?.status === "PENDING_LOCK";

    if (payerFunded) {
      if (payment.status !== "APPROVED") {
        throw new UnprocessableError(
          `Payment is '${payment.status}'; a prepared escrow can only be funded while it is APPROVED`,
        );
      }
    } else if (payment.status !== "SENT" && payment.status !== "CONFIRMED_ON_CHAIN") {
      throw new UnprocessableError(
        `Payment is '${payment.status}'; a lock can only be recorded once the payment has been sent`,
      );
    }
    if (prepared && !payerFunded) {
      throw new ConflictError("This payment already has an escrow");
    }

    // The escrow must pay the address the payment was authorised against. A
    // lock naming any other payee would move the money past every check the
    // decision engine made (D01).
    const payeeAddress = payment.vendorWallet.address;

    const timelock = new Date(input.timelock);
    const expected = computeLockId({
      paymentRef: paymentRefFor(paymentId),
      payer: input.payerAddress as Address,
      payee: payeeAddress as Address,
      token: input.tokenAddress as Address,
      amount: BigInt(input.onChainAmount),
      hashlock: input.hashlock as Hex,
      timelock: BigInt(Math.floor(timelock.getTime() / 1000)),
    });
    if (expected.toLowerCase() !== input.lockId.toLowerCase()) {
      throw new UnprocessableError(
        "Lock id does not match the reported parameters; the escrow could not be located on chain",
      );
    }

    // A prepared escrow is UPDATED, never rewritten. Its row already holds the
    // preimage the payee will need, and creating a second one would strand it —
    // the money would be locked against a hashlock whose secret nothing points
    // at any more, and nobody could ever claim it.
    if (payerFunded) {
      if (prepared.lockId.toLowerCase() !== input.lockId.toLowerCase()) {
        throw new UnprocessableError(
          "This lock does not match the escrow that was authorised for this payment",
        );
      }
      const updated = await this.deps.prisma.$transaction(async (tx) => {
        const row = await tx.htlcSettlement.update({
          where: { id: prepared.id },
          data: { status: "LOCKED", lockTxHash: input.lockTxHash },
        });
        // Only now. The payer's transaction IS the send, so this is the moment
        // the money actually left — not when the approver authorised it.
        await tx.paymentRequest.update({
          where: { id: paymentId },
          data: { status: "SENT", txHash: input.lockTxHash },
        });
        await this.deps.evidence.append(tx, {
          eventType: "htlc_locked",
          paymentRequestId: paymentId,
          timestamp: new Date().toISOString(),
          // The hashlock goes in; the secret never does. An evidence chain
          // carrying the preimage before it was spent would be a public key to
          // the escrow (design principle 2).
          data: {
            escrowAddress: row.escrowAddress,
            lockId: row.lockId,
            hashlock: row.hashlock,
            timelock: row.timelock.toISOString(),
            amount: row.amount.toString(),
            txHash: input.lockTxHash,
            // Recorded because it changes what the row MEANS: the money came
            // from the payer's own wallet, and a refund returns there.
            fundedBy: "payer",
            payerAddress: row.payerAddress,
          },
        });
        return row;
      });
      return toSettlementSummary(updated);
    }

    const row = await this.deps.prisma.$transaction((tx) =>
      writeLockRecord(tx, this.deps.evidence, {
        paymentRequestId: paymentId,
        payeeAddress,
        timelock,
        input,
      }),
    );

    return toSettlementSummary(row);
  }

  /**
   * Records the payee claiming an escrow, which is also their acknowledgment.
   *
   * The preimage is hashed against the stored hashlock before anything is
   * written. That single check is what makes this evidence: it ties the claim
   * to the commitment the platform published when the money was locked, so the
   * payee cannot later say the funds never reached them (D41).
   */
  async recordClaim(paymentId: string, input: RecordClaimRequest): Promise<SettlementSummary> {
    const settlement = await this.load(paymentId);

    if (settlement.status !== "LOCKED") {
      throw new ConflictError(`Escrow is '${settlement.status}'; it cannot be claimed`);
    }
    if (keccak256(input.preimage as Hex).toLowerCase() !== settlement.hashlock.toLowerCase()) {
      throw new UnprocessableError("Preimage does not hash to this escrow's hashlock");
    }

    const settledAt = new Date();
    const timestamp = settledAt.toISOString();

    const updated = await this.deps.prisma.$transaction(async (tx) => {
      const row = await tx.htlcSettlement.update({
        where: { id: settlement.id },
        data: {
          status: "CLAIMED",
          preimage: input.preimage,
          claimTxHash: input.claimTxHash,
          settledAt,
        },
      });

      // The claim IS the acknowledgment, so it lands in the same table the
      // signed route writes to. A dispute asks "did the payee acknowledge
      // receipt", and the answer must not depend on which settlement mode was
      // used — only `method` distinguishes them (D41).
      const existing = await tx.recipientAcknowledgment.findUnique({
        where: { paymentRequestId: paymentId },
      });
      if (!existing) {
        await tx.recipientAcknowledgment.create({
          data: {
            paymentRequestId: paymentId,
            recipientAddress: settlement.payeeAddress,
            method: "HTLC_CLAIM",
            // The commitment the payee opened. There is no EIP-712 payload in
            // this flow and no signature to store; inventing one would make the
            // record read like something it is not.
            recipientCommitment: settlement.hashlock,
            claimTxHash: input.claimTxHash,
          },
        });
      }

      await this.deps.evidence.append(tx, {
        eventType: "htlc_claimed",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          lockId: settlement.lockId,
          preimage: input.preimage,
          claimedBy: settlement.payeeAddress,
          txHash: input.claimTxHash,
        },
      });

      await this.deps.evidence.append(tx, {
        eventType: "ack",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          recipientAddress: settlement.payeeAddress,
          recipientCommitment: settlement.hashlock,
          method: "HTLC_CLAIM",
        },
      });

      return row;
    });

    return toSettlementSummary(updated);
  }

  /**
   * Records an expired escrow returning to the payer, and opens a case.
   *
   * A refund means the money came back, which is the good outcome — but it also
   * means a payee the platform verified never collected a payment it approved.
   * Something is wrong with the address, the payee, or the invoice, and nobody
   * finds out from a balance quietly returning to normal. It goes to the
   * Exception Desk (§7).
   */
  async recordRefund(paymentId: string, input: RecordRefundRequest): Promise<SettlementSummary> {
    const settlement = await this.load(paymentId);

    if (settlement.status !== "LOCKED") {
      throw new ConflictError(`Escrow is '${settlement.status}'; it cannot be refunded`);
    }
    // Not a courtesy check: the contract refuses an early refund, so a report
    // of one is either a bug or a fabrication, and either way it must not be
    // written into the evidence chain.
    if (settlement.timelock.getTime() > Date.now()) {
      throw new UnprocessableError(
        `Escrow is not refundable until ${settlement.timelock.toISOString()}`,
      );
    }

    const settledAt = new Date();
    const timestamp = settledAt.toISOString();

    const updated = await this.deps.prisma.$transaction(async (tx) => {
      const row = await tx.htlcSettlement.update({
        where: { id: settlement.id },
        data: { status: "REFUNDED", refundTxHash: input.refundTxHash, settledAt },
      });

      await tx.paymentRequest.update({
        where: { id: paymentId },
        data: { status: "EXCEPTION" },
      });

      await this.deps.evidence.append(tx, {
        eventType: "htlc_refunded",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          lockId: settlement.lockId,
          refundedTo: settlement.payerAddress,
          amount: settlement.amount.toString(),
          txHash: input.refundTxHash,
        },
      });

      await this.deps.exceptions.createWithin(tx, {
        paymentRequestId: paymentId,
        // The approved payee did not take the money. Until someone establishes
        // why, the working assumption has to be that it was pointed at the
        // wrong place — which is the case this desk exists to work.
        type: "MISDIRECT",
        openedBy: "htlc-settlement",
      });

      return row;
    });

    return toSettlementSummary(updated);
  }

  async get(paymentId: string): Promise<SettlementSummary> {
    return toSettlementSummary(await this.load(paymentId));
  }

  private async load(paymentId: string) {
    const settlement = await this.deps.prisma.htlcSettlement.findUnique({
      where: { paymentRequestId: paymentId },
    });
    if (!settlement) throw new NotFoundError(`Escrow for payment '${paymentId}'`);
    return settlement;
  }
}

type SettlementRow = Prisma.HtlcSettlementGetPayload<Record<string, never>>;

export type WriteLockArgs = {
  paymentRequestId: string;
  payeeAddress: string;
  timelock: Date;
  input: RecordLockRequest;
  /** The secret, when the platform generated it. Never written unencrypted. */
  preimageEncryptedRef?: string;
};

/** The transactional client handed to a $transaction callback. */
export type TxClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Writes the escrow row and its evidence record inside one transaction.
 *
 * Shared by the two ways a lock arrives: reported by an external signer, or
 * broadcast by this API itself. One writer, so the two paths cannot drift on
 * what a locked payment looks like, and so neither can persist a row without
 * the matching evidence (D07).
 */
export async function writeLockRecord(
  tx: TxClient,
  evidence: EvidenceService,
  args: WriteLockArgs,
): Promise<SettlementRow> {
  const { input } = args;
  const timestamp = new Date().toISOString();

  const settlement = await tx.htlcSettlement.create({
    data: {
      paymentRequestId: args.paymentRequestId,
      escrowAddress: input.escrowAddress,
      lockId: input.lockId,
      hashlock: input.hashlock,
      timelock: args.timelock,
      payerAddress: input.payerAddress,
      payeeAddress: args.payeeAddress,
      tokenAddress: input.tokenAddress,
      amount: new Prisma.Decimal(input.amount),
      onChainAmount: input.onChainAmount,
      lockTxHash: input.lockTxHash,
      ...(args.preimageEncryptedRef ? { preimageEncryptedRef: args.preimageEncryptedRef } : {}),
    },
  });

  await evidence.append(tx, {
    eventType: "htlc_locked",
    paymentRequestId: args.paymentRequestId,
    timestamp,
    // The hashlock goes in; the secret never does. An evidence chain carrying
    // the preimage before it was spent would be a public key to the escrow
    // (design principle 2).
    data: {
      escrowAddress: input.escrowAddress,
      lockId: input.lockId,
      hashlock: input.hashlock,
      timelock: args.timelock.toISOString(),
      amount: input.amount,
      txHash: input.lockTxHash,
    },
  });

  return settlement;
}

export function toSettlementSummary(row: SettlementRow): SettlementSummary {
  return {
    paymentRequestId: row.paymentRequestId,
    mode: "HTLC",
    status: row.status,
    escrowAddress: row.escrowAddress,
    lockId: row.lockId,
    hashlock: row.hashlock,
    timelock: row.timelock.toISOString(),
    payerAddress: row.payerAddress,
    payeeAddress: row.payeeAddress,
    tokenAddress: row.tokenAddress,
    amount: row.amount.toString(),
    onChainAmount: row.onChainAmount,
    lockTxHash: row.lockTxHash,
    claimTxHash: row.claimTxHash,
    refundTxHash: row.refundTxHash,
    preimage: row.preimage,
    lockedAt: row.lockedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}
