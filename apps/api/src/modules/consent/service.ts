// P3-P4 — asking the payee, and recording their answer.
//
// This service is the throttle on the whole system. The identity match (P6) is
// the only thing that can tell a sender "this address does not belong to that
// PAN", which makes it a lookup oracle for anyone willing to probe it. Putting
// the payee's signed acceptance in front of it means every probe costs the
// target's active participation and leaves them a record of who asked.
//
// It is therefore an error, not an optimisation, for anything here to be
// skippable: `PaymentService.runDecision` refuses to run without an ACCEPTED
// consent, and that refusal is the control.
//
// Spec: docs/payment-flow.md (P3-P5)

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ConsentPrompt,
  PayeeConsentRequest,
  PayeeConsentResponse,
  RequestConsentResponse,
} from "@cp/shared-types";
import type { Config } from "../../config/index.js";
import { buildPayeeConsentMessage, verifyPayeeConsent } from "../../lib/eip712.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from "../../lib/errors.js";
import type { TierThresholds } from "../decision/types.js";
import type { EvidenceService } from "../evidence/service.js";
import { assessPayeeChallenge, type ChallengeAssessment } from "./challenge.js";

export type ConsentServiceDeps = {
  prisma: PrismaClient;
  evidence: EvidenceService;
  tierThresholds: TierThresholds;
  config: Config;
};

/**
 * What each party's World ID proof is bound to.
 *
 * ROLE-QUALIFIED, not the bare payment id. The two checks authorise different
 * things — "I raised this payment" and "I accept this payment" — and the
 * nullifier table is unique on (nullifier, action, signal). With a bare payment
 * id those are the same signal, so a single human acting as both sides collides
 * with themselves and the second proof is refused as a replay.
 *
 * That is not only a demo problem: it is the correct reading of what a signal
 * is for. Two different authorisations should not share one.
 */
export function senderSignal(paymentId: string): string {
  return `sender:${paymentId}`;
}

export function payeeSignal(paymentId: string): string {
  return `payee:${paymentId}`;
}

export class ConsentService {
  constructor(private readonly deps: ConsentServiceDeps) {}

  /** P3 — put the request in front of the payee. */
  async request(paymentId: string): Promise<RequestConsentResponse> {
    const payment = await this.load(paymentId);

    // Consent belongs before the verdict, so the payment must not have moved.
    // Re-asking a payment already past this point would let a sender collect a
    // second acceptance for money that is already committed.
    if (payment.status !== "DRAFT") {
      throw new ConflictError(
        `Payment is '${payment.status}'; consent can only be requested while it is a draft`,
      );
    }

    // Who is asking has to be a verified party too. Without a payer identity
    // there is nothing for the payee to block, and blocking an address is
    // blocking a disposable.
    if (!payment.payerVendorId) {
      throw new UnprocessableError(
        "This payment names no payer identity, so the payee cannot be told who is asking",
      );
    }

    const blocked = await this.deps.prisma.identityBlock.findUnique({
      where: {
        blockedByVendorId_blockedVendorId: {
          blockedByVendorId: payment.vendorId,
          blockedVendorId: payment.payerVendorId,
        },
      },
      select: { id: true },
    });

    // Refused BEFORE the notification is written. A block that still delivered
    // the prompt would be a mute button, not a block, and the probe the payee
    // was trying to stop would still reach them.
    if (blocked) {
      throw new ForbiddenError("This payee has blocked payment requests from this payer");
    }

    // P2 — the SENDER proves personhood before anyone is asked anything.
    //
    // Unconditional, unlike the payee's risk-based challenge (P5): raising a
    // payment is the act that spends the payee's attention and pulls their
    // record into a comparison, so the party doing it is the one who must be a
    // live human every time. Automating the probe is exactly the attack the
    // consent gate exists to make expensive.
    const senderCheck = await this.requireSenderCheck(payment.payerVendorId, payment.id);

    const challenge = await this.assess(payment);
    const timestamp = new Date().toISOString();

    const notification = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.notification.create({
        data: {
          vendorId: payment.vendorId,
          kind: "CONSENT_REQUESTED",
          paymentRequestId: payment.id,
          // Identifiers only. The payer's legal name is resolved when the
          // prompt is READ, so this row carries nothing a leak could use.
          payload: {
            payerVendorId: payment.payerVendorId,
            amount: payment.amount.toString(),
            token: payment.token,
            invoiceRef: payment.invoiceRef,
            challengeRequired: challenge.required,
          },
        },
        select: { id: true },
      });

      await tx.paymentRequest.update({
        where: { id: payment.id },
        data: { status: "AWAITING_PAYEE_CONSENT" },
      });

      if (senderCheck) {
        await this.deps.evidence.append(tx, {
          eventType: "world_id_check",
          paymentRequestId: payment.id,
          timestamp,
          data: senderCheck,
        });
      }

      return created;
    });

    return {
      paymentRequestId: payment.id,
      notificationId: notification.id,
      status: "AWAITING_PAYEE_CONSENT",
      challengeRequired: challenge.required,
      challengeTriggers: challenge.triggers,
    };
  }

  /** What the payee sees before deciding. */
  async prompt(paymentId: string): Promise<ConsentPrompt> {
    const payment = await this.load(paymentId);
    if (payment.status !== "AWAITING_PAYEE_CONSENT") {
      throw new ConflictError(`Payment is '${payment.status}'; it is not awaiting consent`);
    }
    if (!payment.payer) {
      throw new UnprocessableError("This payment names no payer identity");
    }

    const notification = await this.deps.prisma.notification.findFirst({
      where: { paymentRequestId: payment.id, kind: "CONSENT_REQUESTED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, payload: true },
    });

    // Read back from the notification rather than recomputed. It was decided
    // when consent was requested and written into that row; deciding it a
    // second time here could disagree with what `decide` will enforce, and the
    // payee would be told one thing and refused for another.
    const payload = (notification?.payload ?? {}) as { challengeRequired?: boolean };

    return {
      paymentRequestId: payment.id,
      payerVendorId: payment.payer.id,
      payerLegalName: payment.payer.legalEntityName ?? "",
      payerVerificationTier: payment.payer.verificationTier,
      amount: payment.amount.toString(),
      token: payment.token,
      network: payment.network,
      invoiceRef: payment.invoiceRef,
      payeeAddress: payment.vendorWallet.address,
      requestedAt: (notification?.createdAt ?? payment.updatedAt).toISOString(),
      challengeRequired: payload.challengeRequired === true,
    };
  }

  /** P4 — the payee accepts or denies. */
  async decide(paymentId: string, input: PayeeConsentRequest): Promise<PayeeConsentResponse> {
    const payment = await this.load(paymentId);

    if (payment.status !== "AWAITING_PAYEE_CONSENT") {
      throw new ConflictError(`Payment is '${payment.status}'; it is not awaiting consent`);
    }
    if (payment.payeeConsent) {
      throw new ConflictError("This payment already carries a consent decision");
    }

    const timestamp = new Date().toISOString();
    let challenge: ChallengeAssessment = { required: false, triggers: [] };
    let payeeCheck: WorldIdCheckEvidence | null = null;

    if (input.decision === "ACCEPTED") {
      // The signer must be the address the money would go to. Accepting from
      // any other key would prove that SOMEONE agreed, which is not the claim
      // being made.
      const payoutAddress = payment.vendorWallet.address;
      if (input.signerAddress!.toLowerCase() !== payoutAddress.toLowerCase()) {
        throw new ForbiddenError(
          "Consent must be signed by the payout address named on this payment",
        );
      }
      if (payment.vendorWallet.status !== "CONFIRMED") {
        throw new UnprocessableError(
          `The payout wallet is '${payment.vendorWallet.status}'; only a confirmed wallet may consent`,
        );
      }

      const valid = await verifyPayeeConsent({
        chainId: this.deps.config.HEDERA_CHAIN_ID,
        address: input.signerAddress!,
        signature: input.signature!,
        message: buildPayeeConsentMessage({
          paymentRequestId: payment.id,
          payeeAddress: payoutAddress,
          // Exactly as stored, so the payee signed the amount that is on the
          // payment and not a re-rendering of it.
          amount: payment.amount.toString(),
          token: payment.token,
          invoiceRef: payment.invoiceRef,
        }),
      });
      if (!valid) {
        throw new ForbiddenError("Consent signature does not recover to the payout address");
      }

      // Recomputed here, not trusted from the earlier response: the risk
      // picture can change between asking and answering, and the client is on
      // the far side of that boundary.
      challenge = await this.assess(payment);

      // Gated on the same flag as the sender's check (P2), and for the same
      // reason: when World ID is switched off the routes that mint these
      // verifications refuse, so demanding one would not make payments safer —
      // it would make every payment impossible to accept.
      //
      // Leaving this ungated while P2 was gated meant a deployment with the
      // flag off passed P2 and then dead-ended at P4, which is the worst of
      // both: the control is absent AND the flow is broken.
      if (challenge.required && this.deps.config.WORLD_FEATURE_FLAG_ENABLED) {
        payeeCheck = await this.requireWorldIdCheck(
          payment.vendorId,
          payment.id,
          input.worldIdVerificationId,
        );
      }
    }

    const accepted = input.decision === "ACCEPTED";

    await this.deps.prisma.$transaction(async (tx) => {
      await tx.payeeConsent.create({
        data: {
          paymentRequestId: payment.id,
          decision: input.decision,
          signature: input.signature ?? null,
          signerAddress: input.signerAddress ?? null,
          worldIdVerificationId: input.worldIdVerificationId ?? null,
        },
      });

      await tx.paymentRequest.update({
        where: { id: payment.id },
        data: {
          // A denial does not roll back to DRAFT. The payee said no to THIS
          // request, and letting it return to a draft the sender can re-run
          // would turn one refusal into an invitation to try again.
          status: accepted ? "DECISION_PENDING" : "EXCEPTION",
        },
      });

      if (payeeCheck) {
        // Before the consent record: the check is what made the acceptance
        // admissible, so it precedes it in the chain.
        await this.deps.evidence.append(tx, {
          eventType: "world_id_check",
          paymentRequestId: payment.id,
          timestamp,
          data: payeeCheck,
        });
      }

      await this.deps.evidence.append(tx, {
        eventType: "payee_consent",
        paymentRequestId: payment.id,
        timestamp,
        data: {
          decision: input.decision,
          signerAddress: input.signerAddress ?? null,
          signaturePresent: Boolean(input.signature),
          worldIdVerificationId: input.worldIdVerificationId ?? null,
          challengeTriggers: challenge.triggers,
        },
      });
    });

    return {
      paymentRequestId: payment.id,
      decision: input.decision,
      status: accepted ? "DECISION_PENDING" : "EXCEPTION",
      decidedAt: timestamp,
    };
  }

  /**
   * P2 — the sender's own Selfie Check, bound to this payment.
   *
   * Looked up rather than accepted as a parameter. The three properties that
   * matter — this payment, this party, a payment-time check — are the query
   * itself, so there is no client-supplied id that could name a row satisfying
   * none of them.
   *
   * Skipped when World ID is switched off, because the routes that mint these
   * rows refuse in that state (config: WORLD_FEATURE_FLAG_ENABLED) and a
   * requirement nothing can satisfy would stop every payment rather than the
   * unverified ones.
   */
  private async requireSenderCheck(
    payerVendorId: string,
    paymentId: string,
  ): Promise<WorldIdCheckEvidence | null> {
    if (!this.deps.config.WORLD_FEATURE_FLAG_ENABLED) return null;

    const check = await this.deps.prisma.worldIdVerification.findFirst({
      where: { subject: payerVendorId, signal: senderSignal(paymentId), purpose: "REVERIFICATION" },
      orderBy: { verifiedAt: "desc" },
    });

    if (!check) {
      throw new UnprocessableError(
        "The sender must pass a World ID check for this payment before the payee is asked. " +
          `Verify with signal = "${senderSignal(paymentId)}" (POST /world-id/verify).`,
      );
    }

    return {
      verificationId: check.id,
      purpose: check.purpose,
      credential: check.credential,
      party: "sender",
      nullifierMatchedEnrolment: await this.matchesEnrolment(payerVendorId, check.nullifier),
    };
  }

  /**
   * Whether this proof came from the human who enrolled.
   *
   * Recomputed here rather than assumed. `WorldIdService.accept` does enforce
   * it on the way in, so this should never disagree — but the evidence record
   * asserts it as a fact, and a field that says "matched" because of what
   * another module promised is not evidence, it is a restatement.
   */
  private async matchesEnrolment(subject: string, nullifier: Prisma.Decimal): Promise<boolean> {
    const enrolment = await this.deps.prisma.worldIdVerification.findFirst({
      where: { subject, purpose: "ENROLLMENT" },
      orderBy: { verifiedAt: "asc" },
      select: { nullifier: true },
    });
    return enrolment !== null && enrolment.nullifier.equals(nullifier);
  }

  /**
   * The World ID row the risk engine demanded (P5).
   *
   * Presence is not enough — storing an unvalidated id would look verified and
   * prove nothing. Each check below closes a different substitution:
   *
   *   signal  === paymentId       a check taken for another payment is not reusable
   *   purpose === REVERIFICATION  an enrolment must not double as an acceptance
   *   subject === the payee       someone else's live check is not this payee's
   *
   * Continuity with the enrolled nullifier is already enforced when the proof
   * is accepted (WorldIdService.assertSameHuman), so it is not re-checked here.
   */
  private async requireWorldIdCheck(
    payeeVendorId: string,
    paymentId: string,
    verificationId: string | undefined,
  ): Promise<WorldIdCheckEvidence> {
    if (!verificationId) {
      throw new UnprocessableError(
        "This payment requires the payee to pass a World ID check before accepting. " +
          `Verify with signal = "${payeeSignal(paymentId)}" (POST /world-id/verify).`,
      );
    }

    const verification = await this.deps.prisma.worldIdVerification.findUnique({
      where: { id: verificationId },
    });
    if (!verification) throw new NotFoundError(`World ID verification '${verificationId}'`);

    if (verification.signal !== payeeSignal(paymentId)) {
      throw new ForbiddenError("That World ID check was taken for a different payment");
    }
    if (verification.purpose !== "REVERIFICATION") {
      throw new ForbiddenError("An enrolment cannot stand in for a payment-time check");
    }
    if (verification.subject !== payeeVendorId) {
      throw new ForbiddenError("That World ID check belongs to a different party");
    }

    return {
      verificationId: verification.id,
      purpose: verification.purpose,
      credential: verification.credential,
      party: "payee",
      nullifierMatchedEnrolment: await this.matchesEnrolment(
        payeeVendorId,
        verification.nullifier,
      ),
    };
  }

  /** Gathers what the P5 rules read. The rules themselves stay in challenge.ts. */
  private async assess(payment: LoadedPayment): Promise<ChallengeAssessment> {
    const [priorSettled, lastCheck, lastMismatch] = await Promise.all([
      payment.payerVendorId
        ? this.deps.prisma.paymentRequest.count({
            where: {
              vendorId: payment.vendorId,
              payerVendorId: payment.payerVendorId,
              id: { not: payment.id },
              status: { in: ["SENT", "CONFIRMED_ON_CHAIN"] },
            },
          })
        : Promise.resolve(0),
      this.deps.prisma.worldIdVerification.findFirst({
        where: { subject: payment.vendorId },
        orderBy: { verifiedAt: "desc" },
        select: { verifiedAt: true },
      }),
      this.deps.prisma.notification.findFirst({
        where: { vendorId: payment.vendorId, kind: "IDENTITY_MISMATCH" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    return assessPayeeChallenge({
      now: new Date(),
      hasPriorSettledPayment: priorSettled > 0,
      amount: payment.amount,
      tierCeiling: this.deps.tierThresholds.maxAmountForTier(
        payment.vendor.verificationTier,
      ) as Prisma.Decimal | null,
      walletConfirmedAt: payment.vendorWallet.confirmedAt,
      lastSelfieCheckAt: lastCheck?.verifiedAt ?? null,
      lastIdentityMismatchAt: lastMismatch?.createdAt ?? null,
    });
  }

  private async load(paymentId: string): Promise<LoadedPayment> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: paymentId },
      include: { vendor: true, vendorWallet: true, payer: true, payeeConsent: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);
    return payment;
  }
}

/** The `world_id_check` payload, kept in one place so both parties agree on it. */
type WorldIdCheckEvidence = {
  verificationId: string;
  purpose: string;
  credential: string;
  party: "sender" | "payee";
  nullifierMatchedEnrolment: boolean;
};

type LoadedPayment = Prisma.PaymentRequestGetPayload<{
  include: { vendor: true; vendorWallet: true; payer: true; payeeConsent: true };
}>;
