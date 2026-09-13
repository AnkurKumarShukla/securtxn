// What a payment's status means, in the product's words.
//
// The API's enum is correct and unreadable: `AWAITING_PAYEE_CONSENT` is precise
// and `DECISION_PENDING` tells an operator nothing about whether they should do
// something. Each state gets a short human label, a tone, and — the useful part
// — a line saying WHO IS HOLDING IT, because that is the only question anyone
// opens a payments list to answer.
//
// The raw enum is still shown wherever the exact value matters. This is a
// reading aid, never a replacement.

import type { Tone } from "../../ui/status";

export type StatusMeta = {
  label: string;
  tone: Tone;
  /** Who the payment is currently waiting on. Null when it is finished. */
  waitingOn: string | null;
};

const META: Record<string, StatusMeta> = {
  DRAFT: {
    label: "Draft",
    tone: "idle",
    waitingOn: "you — confirm it is you, then notify the payee",
  },
  AWAITING_PAYEE_CONSENT: {
    label: "Awaiting payee",
    tone: "waiting",
    waitingOn: "the payee — they accept or refuse from their own browser",
  },
  DECISION_PENDING: {
    label: "Ready to check",
    tone: "running",
    waitingOn: "you — run the identity match and the decision",
  },
  AWAITING_APPROVAL: {
    label: "Awaiting approval",
    tone: "waiting",
    waitingOn: "an approver — a human stands between the verdict and the money",
  },
  APPROVED: {
    label: "Approved",
    tone: "running",
    waitingOn: "the approver's machine — the transfer is signed there, not here",
  },
  SENT: { label: "Sent", tone: "ok", waitingOn: null },
  CONFIRMED_ON_CHAIN: { label: "Confirmed on chain", tone: "ok", waitingOn: null },
  SETTLED: { label: "Settled", tone: "ok", waitingOn: null },
  LOCKED: {
    label: "Locked in escrow",
    tone: "waiting",
    waitingOn: "the payee — the money returns to you if they never claim it",
  },
  EXCEPTION: {
    label: "Blocked",
    tone: "failed",
    waitingOn: null,
  },
  REFUNDED: { label: "Refunded", tone: "skipped", waitingOn: null },
  CANCELLED: { label: "Cancelled", tone: "skipped", waitingOn: null },
};

export function statusMeta(status: string): StatusMeta {
  // An unrecognised status is shown verbatim rather than guessed at. A new
  // state added server-side should look unfamiliar, not be silently mislabelled
  // as something the operator already understands.
  return META[status] ?? { label: status.replace(/_/g, " ").toLowerCase(), tone: "idle", waitingOn: null };
}

/** The decision verdict's tone. REVERIFY and SEND_TEST_AMOUNT both mean a human decides. */
export function decisionTone(decision: string | null): Tone {
  if (!decision) return "idle";
  if (decision === "SAFE_TO_SEND") return "ok";
  if (decision === "DO_NOT_SEND") return "failed";
  return "waiting";
}
