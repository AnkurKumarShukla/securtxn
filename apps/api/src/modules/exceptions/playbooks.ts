// Recovery playbooks, one per exception type.
//
// Ordered steps an operator works through. They are deliberately concrete
// actions rather than status labels: an exception desk is only useful if it
// tells a person what to do next, and the ordering encodes what must be
// established before money is chased.
//
// Spec: docs/architecture.md §3, §7 phase 6

import type { ExceptionType, PlaybookStep } from "@cp/shared-types";

const PLAYBOOKS: Record<ExceptionType, string[]> = {
  // Paid more than the invoice.
  OVERPAY: [
    "Confirm the overpaid amount against the invoice and the on-chain transfer",
    "Contact the payee on the independently verified channel on file",
    "Request return of the difference to the original sending address",
    "Confirm the return on chain and reconcile",
  ],

  // Sent to the wrong address. The case this product exists to prevent, and
  // the one where speed matters most.
  MISDIRECT: [
    "Freeze further payments to this vendor wallet",
    "Identify the receiving address and check whether it is a known custodian",
    "Contact the payee on the verified channel to confirm they did not receive it",
    "If a custodian, open a recovery request with the exchange citing the evidence chain",
    "Record the outcome and decide whether to revoke the wallet",
  ],

  // The same invoice paid twice.
  DUPLICATE: [
    "Identify the earlier payment and confirm both settled on chain",
    "Confirm the invoice reference is genuinely the same commitment",
    "Contact the payee on the verified channel and request return of the duplicate",
    "Reconcile once returned, or write off with an approver's sign-off",
  ],

  // Right address, wrong token or chain.
  WRONG_ASSET: [
    "Confirm which asset and network actually received the funds",
    "Check whether the payee controls that address on that network",
    "Arrange a return or a re-send in the correct asset",
    "Correct the vendor wallet's token contract on file",
  ],

  // The payee disputes the payment or its amount.
  DISPUTE: [
    "Retrieve the evidence chain and verify it end to end",
    "Retrieve the signed identity attestation and any recipient acknowledgment",
    "Contact the payee on the verified channel and record their account",
    "Decide the outcome on the evidence and record the reasoning",
  ],
};

/** Fresh playbook for a new case; every step starts PENDING. */
export function playbookFor(type: ExceptionType): PlaybookStep[] {
  return (PLAYBOOKS[type] ?? []).map((step) => ({ step, status: "PENDING" as const }));
}

export { PLAYBOOKS };
