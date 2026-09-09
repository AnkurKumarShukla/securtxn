// Payment creation and the decision run.
//
// This service gathers the inputs; `decide()` makes the call. Keeping that
// split means the decision logic never depends on how the data was fetched, and
// stays testable without a database (D08, D15).
//
// Spec: docs/architecture.md §4.1

import { createHash } from "node:crypto";
import type { VendorMatcher } from "@cp/cre-workflows";
import { Prisma, type PrismaClient, type Vendor, type VendorWallet } from "@prisma/client";
import type { CreatePaymentRequest, DecisionResult, PaymentSummary } from "@cp/shared-types";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import { decide } from "../decision/index.js";
import type { TierThresholds } from "../decision/types.js";
import type { SanctionsScreener } from "../sanctions/index.js";
import { EvidenceService } from "../evidence/service.js";

export type PaymentServiceDeps = {
  prisma: PrismaClient;
  evidence: EvidenceService;
  vendorMatcher: VendorMatcher;
  sanctionsScreener: SanctionsScreener;
  tierThresholds: TierThresholds;
  /** Recorded in evidence so a reader knows which implementation decided. */
  matcherKind: "fallback" | "cre";
};

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  async create(input: CreatePaymentRequest): Promise<PaymentSummary> {
    const wallet = await this.deps.prisma.vendorWallet.findUnique({
      where: { id: input.vendorWalletId },
    });

    // The wallet must belong to the named vendor. Accepting a mismatched pair
    // would let a caller point a payment at any address in the system.
    if (!wallet || wallet.vendorId !== input.vendorId) {
      throw new NotFoundError(`Wallet '${input.vendorWalletId}' for vendor '${input.vendorId}'`);
    }
    if (wallet.network !== input.network) {
      throw new UnprocessableError(
        `Wallet is registered on '${wallet.network}' but the payment names '${input.network}'`,
      );
    }

    const payment = await this.deps.prisma.paymentRequest.create({
      data: {
        vendorId: input.vendorId,
        vendorWalletId: input.vendorWalletId,
        invoiceRef: input.invoiceRef,
        amount: new Prisma.Decimal(input.amount),
        token: input.token,
        network: input.network,
        // A commitment over the payment context. The raw context stays
        // off-chain; only this fixed-size hash may ever be anchored
        // (design principle 2).
        senderContextCommitment: commitmentFor(input),
      },
    });

    return toPaymentSummary(payment);
  }

  /**
   * Runs vendor matching and sanctions screening, then the decision engine.
   *
   * Status only advances to AWAITING_APPROVAL for outcomes that may proceed.
   * DO_NOT_SEND and REVERIFY stay at DECISION_PENDING so they surface to a
   * human instead of drifting toward the approval queue (§4.1).
   */
  async runDecision(paymentId: string): Promise<DecisionResult> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: paymentId },
      include: { vendor: true, vendorWallet: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);

    if (payment.status !== "DRAFT" && payment.status !== "DECISION_PENDING") {
      throw new ConflictError(`Payment is '${payment.status}'; a decision cannot be re-run`);
    }

    const vendor: Vendor = payment.vendor;
    const wallet: VendorWallet = payment.vendorWallet;
    const legalName = displayName(vendor);

    const [matchResult, sanctions] = await Promise.all([
      this.deps.vendorMatcher.match({
        vendorId: vendor.id,
        claimedLegalName: legalName,
        walletAddress: wallet.address,
        network: wallet.network,
        ...(wallet.tokenContract ? { tokenContract: wallet.tokenContract } : {}),
      }),
      this.deps.sanctionsScreener.screen({
        vendorId: vendor.id,
        legalName,
        walletAddress: wallet.address,
        network: wallet.network,
        country: vendor.country,
      }),
    ]);

    const verdict = decide(
      {
        vendorWallet: {
          status: wallet.status,
          address: wallet.address,
          network: wallet.network,
        },
        verificationTier: vendor.verificationTier,
        matchResult,
        sanctionsHit: sanctions.sanctionsHit,
        isNewOrChangedAddress: await this.isFirstPaymentToAddress(payment.id, wallet),
        amount: payment.amount,
      },
      this.deps.tierThresholds,
    );

    const proceeds = verdict.decision === "SAFE_TO_SEND" || verdict.decision === "SEND_TEST_AMOUNT";
    const timestamp = new Date().toISOString();

    // The status change and BOTH evidence records commit together. If any part
    // fails, none of it happened — a decision with no evidence, or evidence
    // for a decision that was never applied, are both worse than an error
    // (D07).
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.paymentRequest.update({
        where: { id: paymentId },
        data: {
          decision: verdict.decision,
          decisionReasonCode: verdict.reasonCode,
          matchScore: matchResult.score,
          status: proceeds ? "AWAITING_APPROVAL" : "DECISION_PENDING",
        },
      });

      // Two records, in causal order: what the matcher found, then what was
      // decided from it. A single combined record would lose the distinction
      // between "the match was wrong" and "the policy was wrong".
      await this.deps.evidence.append(tx, {
        eventType: "vendor_match",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          matched: matchResult.match,
          score: matchResult.score,
          reasonCode: matchResult.reasonCode,
          matcher: this.deps.matcherKind,
        },
      });

      await this.deps.evidence.append(tx, {
        eventType: "decision",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          decision: verdict.decision,
          reasonCode: verdict.reasonCode,
          matchScore: matchResult.score,
          tierLimitApplied: verdict.tierLimitApplied,
        },
      });
    });

    return {
      decision: verdict.decision,
      reasonCode: verdict.reasonCode,
      matchScore: matchResult.score,
    };
  }

  async get(paymentId: string): Promise<PaymentSummary> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);
    return toPaymentSummary(payment);
  }

  /**
   * True when no earlier payment to this address has been sent.
   *
   * Deliberately looks at SENT/CONFIRMED payments only: a DRAFT to the same
   * address proves nothing — the attacker could have created it themselves.
   */
  private async isFirstPaymentToAddress(
    currentPaymentId: string,
    wallet: VendorWallet,
  ): Promise<boolean> {
    const previous = await this.deps.prisma.paymentRequest.count({
      where: {
        id: { not: currentPaymentId },
        vendorWallet: { address: wallet.address, network: wallet.network },
        status: { in: ["SENT", "CONFIRMED_ON_CHAIN"] },
      },
    });
    return previous === 0;
  }
}

function displayName(vendor: Vendor): string {
  return (
    vendor.legalEntityName ??
    [vendor.legalFirstName, vendor.legalLastName].filter(Boolean).join(" ")
  );
}

/** keccak-style commitment over the payment context; sha256 per §4.8's allowance. */
function commitmentFor(input: CreatePaymentRequest): string {
  const canonical = [
    input.vendorId,
    input.vendorWalletId,
    input.invoiceRef,
    input.amount,
    input.token,
    input.network,
  ].join("|");
  return `0x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function toPaymentSummary(
  payment: Prisma.PaymentRequestGetPayload<Record<string, never>>,
): PaymentSummary {
  return {
    id: payment.id,
    vendorId: payment.vendorId,
    vendorWalletId: payment.vendorWalletId,
    invoiceRef: payment.invoiceRef,
    amount: payment.amount.toString(),
    token: payment.token,
    network: payment.network as PaymentSummary["network"],
    status: payment.status,
    decision: payment.decision,
    decisionReasonCode: payment.decisionReasonCode as PaymentSummary["decisionReasonCode"],
    matchScore: payment.matchScore,
    txHash: payment.txHash,
    senderContextCommitment: payment.senderContextCommitment,
    createdAt: payment.createdAt.toISOString(),
  };
}
