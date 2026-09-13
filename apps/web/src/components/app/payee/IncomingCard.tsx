"use client";

// One payment asking for this payee's consent.
//
// The card has to carry enough for someone to answer "is this mine, and is it
// right?" without leaving the page: how much, against which invoice, from whom,
// and how well that sender is themselves verified.

import { payeeSignal } from "../../../lib/flow";
import type { Incoming, PayeeFlow } from "../../../hooks/usePayeeFlow";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { StatusPill } from "../../ui/StatusPill";
import { WorldIdStep } from "../../ui/WorldIdStep";

export function IncomingCard({
  payment,
  flow,
  vendorId,
}: {
  payment: Incoming;
  flow: PayeeFlow;
  vendorId: string;
}) {
  // Busy is keyed on the payment id, so two payments of the same amount cannot
  // both light up when only one is being answered.
  const accepting = flow.busy === `accept ${payment.paymentRequestId}`;
  const denying = flow.busy === `deny ${payment.paymentRequestId}`;
  const otherBusy = flow.busy !== null && !accepting && !denying;
  const worldIdDone = Boolean(flow.worldIdForPayment[payment.paymentRequestId]);

  // The sender's own verification tier is the payee's single most
  // decision-relevant fact, and it used to render as a grey string.
  const unverified = payment.payerVerificationTier === "TIER0_UNVERIFIED";

  return (
    <div className="well p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[22px] font-semibold tracking-tight tabular-nums text-mist-50">
          {payment.amount}{" "}
          <span className="text-[14px] font-medium text-mist-400">{payment.token}</span>
        </span>
        <span className="font-mono text-[11.5px] text-mist-500">{payment.invoiceRef}</span>
      </div>

      <div className="mt-3">
        <Field k="From" v={payment.payerLegalName || "(unnamed)"} />
        <Field
          k="Their verification"
          v={payment.payerVerificationTier}
          tone={unverified ? "warn" : "ok"}
          hint="How far the sending party got through their own identity checks."
        />
        <Field k="To your address" v={payment.payeeAddress} mono />
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
            Prove it is still you (P5)
          </span>
          <StatusPill
            tone={
              flow.worldIdForPayment[payment.paymentRequestId]
                ? "ok"
                : payment.challengeRequired
                  ? "waiting"
                  : "idle"
            }
          >
            {flow.worldIdForPayment[payment.paymentRequestId]
              ? "done"
              : payment.challengeRequired
                ? "required"
                : "not required"}
          </StatusPill>
        </div>
        <WorldIdStep
          title="Selfie check"
          purpose="REVERIFICATION"
          signal={payeeSignal(payment.paymentRequestId)}
          subject={vendorId}
          onVerified={(id) =>
            flow.setWorldIdForPayment((m) => ({ ...m, [payment.paymentRequestId]: id }))
          }
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* Accepting is blocked until the check is done, when one is required.
            The server refuses it either way — this only means the refusal
            arrives as a disabled button and a reason, instead of as an error
            after the person has already signed. Denying is never gated: a
            refusal needs no proof of anything. */}
        <Button
          variant="primary"
          onClick={() => void flow.decide(payment, "ACCEPTED")}
          disabled={otherBusy || (payment.challengeRequired && !worldIdDone)}
          busy={accepting}
        >
          Accept and sign
        </Button>
        <Button
          variant="halt"
          onClick={() => void flow.decide(payment, "DENIED")}
          disabled={otherBusy}
          busy={denying}
        >
          Deny
        </Button>
        {payment.challengeRequired && !worldIdDone && (
          <span className="text-2xs text-mist-500">
            This payer's address is new or changed, so the check above is required first.
          </span>
        )}
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-mist-500">
        Accepting signs with your payout key over this amount and invoice. Denying needs no
        signature and stops the payment dead — nothing about you is checked.
      </p>
    </div>
  );
}
