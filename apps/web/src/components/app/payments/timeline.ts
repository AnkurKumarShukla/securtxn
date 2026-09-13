// A payment's life, derived rather than stored.
//
// The API records a STATUS, one value, and the screen has to show a history.
// Those are reconcilable because the flow is strictly ordered: a payment that
// is AWAITING_APPROVAL necessarily got its payee's consent and passed the
// decision, or it could not have reached that state — the services refuse
// every out-of-order call. So the whole timeline can be read off one status,
// plus the settlement row for the escrow tail.
//
// Deriving it beats storing per-stage timestamps we would then have to keep
// truthful, and it cannot drift from what the server actually believes.

import type { PaymentSummary } from "@cp/shared-types";
import type { Tone } from "../../ui/status";
import type { SettlementRow } from "../../../lib/api-client";

export type StageId =
  | "raised"
  | "senderCheck"
  | "notified"
  | "payeeDecision"
  | "decision"
  | "approval"
  | "settlement"
  | "escrow"
  | "evidence";

export type Stage = {
  id: StageId;
  /** The spec's label, so a reviewer can cross-reference. */
  code: string;
  title: string;
  /** What this stage proves. Kept from the original flow definitions. */
  proves: string;
  tone: Tone;
  /** Shown under the title when the stage has something to say. */
  detail?: string | undefined;
};

/** How far along the lifecycle a status sits. Anything before it has happened. */
const ORDER: Record<string, number> = {
  DRAFT: 0,
  AWAITING_PAYEE_CONSENT: 1,
  DECISION_PENDING: 2,
  AWAITING_APPROVAL: 3,
  APPROVED: 3,
  SENT: 4,
  CONFIRMED_ON_CHAIN: 5,
  LOCKED: 4,
  SETTLED: 5,
  REFUNDED: 5,
};

export function deriveStages(
  payment: PaymentSummary,
  settlement: SettlementRow | null,
  evidence: { chainValid: boolean; count: number } | null,
): Stage[] {
  const rank = ORDER[payment.status] ?? 0;
  const blocked = payment.status === "EXCEPTION";
  const refused = payment.decision === "DO_NOT_SEND" || payment.decision === "REVERIFY";

  /** Done if we got past it; the current one is live; otherwise not started. */
  const at = (needed: number, live: Tone = "waiting"): Tone => {
    if (blocked && rank <= needed) return "failed";
    if (rank > needed) return "ok";
    if (rank === needed) return live;
    return "idle";
  };

  const isHtlc = payment.settlementMode === "HTLC";

  return [
    {
      id: "raised",
      code: "P1",
      title: "Payment raised",
      proves: "you stated the address and who you intend to pay",
      tone: "ok",
      detail: `${payment.amount} ${payment.token} against ${payment.invoiceRef}`,
    },
    {
      id: "senderCheck",
      code: "P2",
      title: "You confirmed it was you",
      proves: "a live human raised this payment — required every time",
      // Reaching AWAITING_PAYEE_CONSENT is the proof: `request-consent` is
      // refused outright without this check recorded against this payment.
      tone: rank >= 1 ? "ok" : "waiting",
      detail: rank >= 1 ? undefined : "a World ID check, bound to this payment",
    },
    {
      id: "notified",
      code: "P3",
      title: "Payee notified",
      proves: "they were told who is asking, and for how much",
      tone: rank >= 1 ? "ok" : "idle",
    },
    {
      id: "payeeDecision",
      code: "P4+P5",
      title: "Payee decided",
      proves: "they accept from their own browser, signing with their own key — you cannot do it for them",
      tone: blocked && rank <= 1 ? "failed" : at(1),
      detail:
        blocked && rank <= 1
          ? "the payee refused — the payment stops here, and nothing about them was checked"
          : rank >= 2
            ? "accepted and signed with their payout key"
            : "waiting on them",
    },
    {
      id: "decision",
      code: "P6+P7",
      title: "Identity match and decision",
      proves: "the enclave compares digests; nothing about either party is revealed to the other",
      tone: payment.decision
        ? refused
          ? payment.decision === "DO_NOT_SEND"
            ? "failed"
            : "waiting"
          : "ok"
        : at(2, "running"),
      detail: payment.decision
        ? `${payment.decision}${payment.decisionReasonCode ? ` · ${payment.decisionReasonCode}` : ""}`
        : undefined,
    },
    {
      id: "approval",
      code: "P8",
      title: "Human approval",
      proves: "a person stands between the verdict and the money",
      tone: at(3),
    },
    {
      id: "settlement",
      code: "P9",
      title: isHtlc ? "Locked in escrow" : "Sent",
      proves: isHtlc
        ? "the money is held against a secret only the payee can reveal"
        : "the money moved outright — there is no undo",
      // FOR AN ESCROW, THE SETTLEMENT ROW IS THE ANSWER, not the payment
      // status. `at(4)` treats SENT as "still happening" and only settles at
      // CONFIRMED_ON_CHAIN — so a payment whose escrow was funded, and even
      // claimed, sat here pulsing amber as though it were still waiting. The
      // lock existing IS the stage being done; everything after it is a
      // different stage.
      tone: isHtlc
        ? settlement
          ? settlement.status === "PENDING_LOCK"
            ? "waiting"
            : "ok"
          : at(4)
        : at(4),
      detail: (isHtlc ? (settlement?.lockTxHash ?? settlement?.lockId) : payment.txHash) ?? undefined,
    },
    // Only for escrowed payments. A DIRECT payment has no escrow and showing a
    // permanently grey stage for it implies something is missing.
    ...(isHtlc
      ? [
          {
            id: "escrow" as const,
            code: "P10",
            title: "Payee claimed",
            proves: "the reveal on chain IS the receipt — nobody can produce it for them",
            tone: (settlement?.status === "CLAIMED"
              ? "ok"
              : settlement?.status === "REFUNDED"
                ? "skipped"
                : settlement
                  ? "waiting"
                  : "idle") as Tone,
            detail:
              settlement?.status === "REFUNDED"
                ? "nobody claimed in time, so the money came back to you"
                : (settlement?.claimTxHash ?? undefined),
          },
        ]
      : []),
    {
      id: "evidence",
      code: "P12",
      title: "Evidence recorded",
      proves: "every step above left a hash-linked record, in causal order",
      tone: evidence ? (evidence.chainValid ? "ok" : "failed") : "idle",
      detail: evidence
        ? `${evidence.count} records, chain ${evidence.chainValid ? "valid" : "BROKEN"}`
        : undefined,
    },
  ];
}
