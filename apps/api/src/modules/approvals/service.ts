// The approval queue.
//
// This service sits on the API side of the boundary. It writes proposals and
// records completed sends — it never signs anything, and there is no code path
// from here to a key. Signing happens in apps/approval-bridge, on the
// approver's machine (D12, D32).
//
// Spec: docs/architecture.md §4.1, §4.3

import type { PrismaClient } from "@prisma/client";
import type {
  PendingProposal,
  ReportSentRequest,
  ReportSentResponse,
} from "@cp/shared-types";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import type { EvidenceService } from "../evidence/service.js";

export type ApprovalServiceDeps = {
  prisma: PrismaClient;
  evidence: EvidenceService;
};

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  /**
   * Queues a payment for human approval.
   *
   * Agent-scoped, and this is the furthest autonomous code can go: writing a
   * proposal is not approving one. The API rejects an approver token here, and
   * rejects an agent token on every /approvals route (design principle 1).
   */
  async propose(
    paymentId: string,
    proposedBy: string,
    selfieCheckProofRef?: string,
  ): Promise<PendingProposal> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: paymentId },
      include: { vendor: true, vendorWallet: true, proposal: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);

    // Only a decision that permits sending may be queued. A DO_NOT_SEND or
    // REVERIFY payment reaching the approver's terminal is how a human ends up
    // rubber-stamping something the engine already refused.
    if (payment.status !== "AWAITING_APPROVAL") {
      throw new UnprocessableError(
        `Payment is '${payment.status}'; only AWAITING_APPROVAL payments can be proposed`,
      );
    }
    if (payment.proposal) {
      throw new ConflictError("Payment has already been proposed");
    }

    const proposal = await this.deps.prisma.proposal.create({
      data: {
        paymentRequestId: paymentId,
        proposedBy,
        ...(selfieCheckProofRef ? { selfieCheckProofRef } : {}),
        isNewOrChangedAddress: payment.decisionReasonCode === "NEW_OR_CHANGED_ADDRESS",
      },
    });

    return toPendingProposal({ proposal, payment });
  }

  /** The queue the bridge polls. Consumed proposals are gone from it. */
  async listPending(): Promise<PendingProposal[]> {
    const proposals = await this.deps.prisma.proposal.findMany({
      where: { consumedAt: null },
      orderBy: { createdAt: "asc" },
      include: { paymentRequest: { include: { vendor: true, vendorWallet: true } } },
    });

    return proposals.map((proposal) =>
      toPendingProposal({ proposal, payment: proposal.paymentRequest }),
    );
  }

  /**
   * Records a completed send.
   *
   * The API never observes the signing itself — it learns the outcome here,
   * which is exactly why the bridge is the only thing that ever holds a key.
   */
  async reportSent(
    proposalId: string,
    input: ReportSentRequest,
  ): Promise<ReportSentResponse> {
    const proposal = await this.deps.prisma.proposal.findUnique({
      where: { id: proposalId },
      include: { paymentRequest: { include: { vendorWallet: true } } },
    });
    if (!proposal) throw new NotFoundError(`Proposal '${proposalId}'`);
    if (proposal.consumedAt) {
      // Guards a double-send: the same proposal reported twice would produce
      // two ApprovalEvents and two send records for one payment.
      throw new ConflictError("Proposal has already been reported as sent");
    }

    const payment = proposal.paymentRequest;
    if (payment.status !== "AWAITING_APPROVAL") {
      throw new ConflictError(`Payment is '${payment.status}'; a send cannot be recorded`);
    }

    const ledgerConfirmedAt = new Date(input.ledgerConfirmedAt);
    const timestamp = new Date().toISOString();

    // Status change, approval event, proposal consumption and BOTH evidence
    // records commit together. A send with no evidence is worse than an error
    // (D07).
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.paymentRequest.update({
        where: { id: payment.id },
        data: { status: "SENT", txHash: input.txHash },
      });

      await tx.approvalEvent.create({
        data: {
          paymentRequestId: payment.id,
          approverId: input.approverId,
          selfieCheckVerified: proposal.selfieCheckProofRef !== null,
          ...(proposal.selfieCheckProofRef
            ? { selfieCheckProofRef: proposal.selfieCheckProofRef }
            : {}),
          // True only because the bridge reported a device confirmation. With
          // no hardware wallet in scope this reflects the transport in use, and
          // must not be presented as hardware custody (D32).
          ledgerConfirmed: true,
          ledgerConfirmedAt,
        },
      });

      await tx.proposal.update({
        where: { id: proposalId },
        data: { consumedAt: new Date() },
      });

      await this.deps.evidence.append(tx, {
        eventType: "approval",
        paymentRequestId: payment.id,
        timestamp,
        data: {
          approverId: input.approverId,
          selfieCheckVerified: proposal.selfieCheckProofRef !== null,
          ledgerConfirmed: true,
        },
      });

      await this.deps.evidence.append(tx, {
        eventType: "send",
        paymentRequestId: payment.id,
        timestamp,
        data: {
          txHash: input.txHash,
          network: payment.network,
          toAddress: payment.vendorWallet.address,
          amount: payment.amount.toString(),
          token: payment.token,
        },
      });
    });

    return { paymentRequestId: payment.id, status: "SENT", txHash: input.txHash };
  }
}

type ProposalRow = {
  id: string;
  isNewOrChangedAddress: boolean;
  createdAt: Date;
};

type PaymentRow = {
  id: string;
  invoiceRef: string;
  amount: { toString(): string };
  token: string;
  network: string;
  decision: string | null;
  decisionReasonCode: string | null;
  settlementMode: string;
  vendor: { legalEntityName: string | null; legalFirstName: string | null; legalLastName: string | null };
  vendorWallet: { address: string };
};

/**
 * The row an approver reads before deciding to sign.
 *
 * Carries no PII beyond the display name: the operator needs to recognise the
 * payee, not review their identity documents (D06).
 */
function toPendingProposal(input: { proposal: ProposalRow; payment: PaymentRow }): PendingProposal {
  const { proposal, payment } = input;
  return {
    id: proposal.id,
    paymentRequestId: payment.id,
    vendorName:
      payment.vendor.legalEntityName ??
      [payment.vendor.legalFirstName, payment.vendor.legalLastName].filter(Boolean).join(" "),
    invoiceRef: payment.invoiceRef,
    address: payment.vendorWallet.address as PendingProposal["address"],
    network: payment.network as PendingProposal["network"],
    amount: payment.amount.toString(),
    token: payment.token,
    decision: payment.decision as PendingProposal["decision"],
    decisionReasonCode: payment.decisionReasonCode as PendingProposal["decisionReasonCode"],
    settlementMode: payment.settlementMode as PendingProposal["settlementMode"],
    isNewOrChangedAddress: proposal.isNewOrChangedAddress,
    proposedAt: proposal.createdAt.toISOString(),
  };
}
