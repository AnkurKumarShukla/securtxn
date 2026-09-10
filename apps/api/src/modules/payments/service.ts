// Payment creation and the decision run.
//
// This service gathers the inputs; `decide()` makes the call. Keeping that
// split means the decision logic never depends on how the data was fetched, and
// stays testable without a database (D08, D15).
//
// Spec: docs/architecture.md §4.1

import { createHash } from "node:crypto";
import { keccak256, toHex } from "viem";
import { canonicalEntityName, type VendorMatcher } from "@cp/cre-workflows";
import { Prisma, type PrismaClient, type Vendor, type VendorWallet } from "@prisma/client";
import type {
  AcknowledgmentRequest,
  AcknowledgmentResponse,
  CreatePaymentRequest,
  DecisionResult,
  PaymentSummary,
} from "@cp/shared-types";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import { buildAcknowledgmentMessage, verifyAcknowledgment } from "../../lib/eip712.js";
import { encryptJson, hmac } from "../../lib/crypto.js";
import type { Config } from "../../config/index.js";
import { decide, recommendSettlementMode } from "../decision/index.js";
import type { TierThresholds } from "../decision/types.js";
import { KYC_STATUS, type ComplianceGateway } from "@cp/contracts";
import type { SanctionsScreener } from "../sanctions/index.js";
import { EvidenceService } from "../evidence/service.js";
import { ExceptionService } from "../exceptions/service.js";

export type PaymentServiceDeps = {
  prisma: PrismaClient;
  /**
   * The ATS token's compliance list (O8). Optional: an API running without a
   * chain behind it still has to decide payments.
   */
  compliance?: ComplianceGateway;
  /** Which tokenised security to ask about. Unset means there is nothing to ask. */
  atsSecurityId?: string | undefined;
  evidence: EvidenceService;
  exceptions: ExceptionService;
  vendorMatcher: VendorMatcher;
  sanctionsScreener: SanctionsScreener;
  tierThresholds: TierThresholds;
  /** Recorded in evidence so a reader knows which implementation decided. */
  matcherKind: "fallback" | "cre";
  config: Config;
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
        payerVendorId: input.payerVendorId,

        // Reduced to digests HERE and never stored in the clear (D62). The
        // canonicalisation must be identical to the one the payee's digest was
        // written with at identity completion, or two spellings of the same
        // company would never agree.
        //
        // A name with no distinguishing tokens ("Private Limited") canonicalises
        // to null; storing null means P6 cannot match, which is the correct
        // failure — the alternative is a digest of the empty string matching
        // every other such name.
        claimedPayeeNameHmac: (() => {
          const canonical = canonicalEntityName(input.intendedPayeeName);
          return canonical ? hmac(canonical, this.deps.config.HMAC_PEPPER) : null;
        })(),
        claimedPayeePanHmac: hmac(input.intendedPayeePan, this.deps.config.HMAC_PEPPER),

        invoiceRef: input.invoiceRef,
        amount: new Prisma.Decimal(input.amount),
        token: input.token,
        network: input.network,
        settlementMode: input.settlementMode,
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
      include: { vendor: true, vendorWallet: true, payeeConsent: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);

    if (payment.status !== "DRAFT" && payment.status !== "DECISION_PENDING") {
      throw new ConflictError(`Payment is '${payment.status}'; a decision cannot be re-run`);
    }

    // P4 GATES P6. Nothing about the payee is looked up until the payee has
    // agreed to be looked up — this check is the whole reason the match is not
    // a free identity oracle, so it belongs here, before any lookup, rather
    // than as a policy the caller is trusted to follow.
    //
    // A DRAFT payment that never went through P3 lands here too, and is
    // refused for the same reason: no consent on file is not consent.
    if (payment.payeeConsent?.decision !== "ACCEPTED") {
      throw new UnprocessableError(
        "The payee has not accepted this payment, so their identity may not be checked. " +
          "Request consent first (POST /payments/:id/request-consent).",
      );
    }

    const vendor: Vendor = payment.vendor;
    const wallet: VendorWallet = payment.vendorWallet;
    const legalName = displayName(vendor);

    // The claim comes from the SENDER, recorded at P1 — never derived from the
    // payee's own record. Comparing a record to itself is what the previous
    // version did, and it made the identity check unfailable (D62).
    if (!payment.claimedPayeeNameHmac || !payment.claimedPayeePanHmac) {
      throw new UnprocessableError(
        "This payment carries no payee claim, so identity cannot be verified. " +
          "Recreate it with the intended payee's name and PAN.",
      );
    }

    const [matchResult, sanctions] = await Promise.all([
      this.deps.vendorMatcher.match({
        vendorId: vendor.id,
        claimedNameHmac: payment.claimedPayeeNameHmac,
        claimedPanHmac: payment.claimedPayeePanHmac,
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
        onChainKycGranted: await this.isKycGrantedOnChain(wallet.address),
        vendorWallet: {
          status: wallet.status,
          address: wallet.address,
          network: wallet.network,
        },
        verificationTier: vendor.verificationTier,
        matchResult,
        sanctionsHit: sanctions.sanctionsHit,
        isDuplicate: await this.isDuplicateInvoice(payment.id, payment.vendorId, payment.invoiceRef),
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
          matchScore: null,
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
          score: null,
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
          matchScore: null,
          tierLimitApplied: verdict.tierLimitApplied,
        },
      });

      // A blocked duplicate opens a case in the same transaction. It is not
      // enough to refuse it: someone has to find out why a second payment was
      // raised for an invoice that was already settled (§7 phase 6).
      // The mismatch alert (P6). Someone claimed this payee's identity and got
      // it wrong; a silent failure is the prober's ideal outcome, so the payee
      // is told inside the same transaction that recorded the verdict.
      //
      // Identifiers only, like every other payload: the alert says WHO asked,
      // never what they claimed. Echoing the attempted name or PAN back would
      // hand the payee a copy of whatever the prober typed.
      if (!matchResult.match && payment.payerVendorId) {
        await tx.notification.create({
          data: {
            vendorId: payment.vendorId,
            kind: "IDENTITY_MISMATCH",
            paymentRequestId: paymentId,
            payload: {
              payerVendorId: payment.payerVendorId,
              reasonCode: matchResult.reasonCode,
              invoiceRef: payment.invoiceRef,
            },
          },
        });
      }

      if (verdict.reasonCode === "DUPLICATE_PAYMENT") {
        await this.deps.exceptions.createWithin(tx, {
          paymentRequestId: paymentId,
          type: "DUPLICATE",
          openedBy: "decision-engine",
        });
      }
    });

    return {
      decision: verdict.decision,
      reasonCode: verdict.reasonCode,
      matchScore: null,
      recommendedSettlementMode: recommendSettlementMode(verdict.reasonCode),
    };
  }

  /**
   * Does the token itself accept this address? (O8)
   *
   * SELF-DISABLING WITHOUT A CHAIN. With a mock gateway or no configured
   * security there is nothing authoritative to ask, and the mock answers
   * NOT_GRANTED for every address that never went through `/grant-kyc` — so
   * enforcing it would block every payment on an in-memory map. Returning true
   * there is not a loophole: the gate exists to reflect what the chain will do,
   * and where there is no chain it has nothing to reflect.
   */
  private async isKycGrantedOnChain(address: string): Promise<boolean> {
    const compliance = this.deps.compliance;
    const securityId = this.deps.atsSecurityId;
    if (!compliance || compliance.kind === "mock" || !securityId) return true;

    const status = await compliance.getKycStatus({ securityId, account: address });
    return status === KYC_STATUS.GRANTED;
  }

  /**
   * Records a recipient's signed acknowledgment of receipt.
   *
   * This is non-repudiation of receipt: the payee cannot later claim the money
   * never arrived, and it is a signed act by them rather than a note in our
   * records. The raw context is hashed to a commitment and stored encrypted —
   * only the commitment is ever anchored (design principle 2).
   */
  async acknowledge(
    paymentId: string,
    input: AcknowledgmentRequest,
  ): Promise<AcknowledgmentResponse> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: paymentId },
      include: { vendorWallet: true, recipientAck: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);

    // Only a payment that actually went out can be acknowledged.
    if (payment.status !== "SENT" && payment.status !== "CONFIRMED_ON_CHAIN") {
      throw new UnprocessableError(
        `Payment is '${payment.status}'; only a sent payment can be acknowledged`,
      );
    }
    if (payment.recipientAck) {
      throw new ConflictError("This payment has already been acknowledged");
    }

    // The signer must be the address the money was sent to. Accepting any
    // signature would let a third party manufacture a receipt.
    if (input.recipientAddress.toLowerCase() !== payment.vendorWallet.address.toLowerCase()) {
      throw new UnprocessableError(
        "Acknowledgment must be signed by the address the payment was sent to",
      );
    }

    const commitment = commitmentOver(input.acknowledgedContext);

    const valid = await verifyAcknowledgment({
      chainId: this.deps.config.EIP712_CHAIN_ID,
      address: input.recipientAddress,
      signature: input.recipientSignature,
      message: buildAcknowledgmentMessage({
        paymentRequestId: paymentId,
        recipientAddress: input.recipientAddress,
        commitment,
      }),
    });
    if (!valid) {
      throw new UnprocessableError("Signature does not recover to the recipient address");
    }

    const sealed = encryptJson(input.acknowledgedContext, this.deps.config.PII_ENCRYPTION_KEY);
    const timestamp = new Date().toISOString();

    const record = await this.deps.prisma.$transaction(async (tx) => {
      const blob = await tx.encryptedBlob.create({
        data: {
          kind: "ACK_CONTEXT",
          ciphertext: new Uint8Array(sealed.ciphertext),
          iv: new Uint8Array(sealed.iv),
          authTag: new Uint8Array(sealed.authTag),
          contentType: "application/json",
          byteLength: sealed.ciphertext.byteLength,
        },
      });

      const ack = await tx.recipientAcknowledgment.create({
        data: {
          paymentRequestId: paymentId,
          recipientAddress: input.recipientAddress,
          method: "EIP712_SIGNATURE",
          recipientSignature: input.recipientSignature,
          recipientCommitment: commitment,
          rawContextEncryptedRef: blob.id,
        },
      });

      await this.deps.evidence.append(tx, {
        eventType: "ack",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          recipientAddress: input.recipientAddress,
          recipientCommitment: commitment,
          method: "EIP712_SIGNATURE",
        },
      });

      return ack;
    });

    return {
      paymentRequestId: paymentId,
      recipientAddress: record.recipientAddress as AcknowledgmentResponse["recipientAddress"],
      recipientCommitment: record.recipientCommitment as AcknowledgmentResponse["recipientCommitment"],
      verifiedAt: record.verifiedAt.toISOString(),
    };
  }

  async get(paymentId: string): Promise<PaymentSummary> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);
    return toPaymentSummary(payment);
  }

  /**
   * True when this invoice has already been paid.
   *
   * Matched on vendor + invoiceRef against payments that actually settled.
   * Comparing amounts would miss a duplicate raised for a slightly different
   * figure, which is the common shape of the mistake.
   */
  private async isDuplicateInvoice(
    currentPaymentId: string,
    vendorId: string,
    invoiceRef: string,
  ): Promise<boolean> {
    const settled = await this.deps.prisma.paymentRequest.count({
      where: {
        id: { not: currentPaymentId },
        vendorId,
        invoiceRef,
        status: { in: ["SENT", "CONFIRMED_ON_CHAIN"] },
      },
    });
    return settled > 0;
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

/**
 * Commitment over the acknowledged context.
 *
 * Sorted keys so the recipient and the server hash the same bytes — the signer
 * builds this object independently, and insertion order must not change the
 * result (D36).
 */
function commitmentOver(context: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(context)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  );
  return keccak256(toHex(canonical));
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
    settlementMode: payment.settlementMode,
    decision: payment.decision,
    decisionReasonCode: payment.decisionReasonCode as PaymentSummary["decisionReasonCode"],
    matchScore: payment.matchScore,
    txHash: payment.txHash,
    senderContextCommitment: payment.senderContextCommitment,
    createdAt: payment.createdAt.toISOString(),
  };
}
