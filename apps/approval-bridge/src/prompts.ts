// Terminal rendering and operator confirmation.
//
// What is shown here is what a human decides on. It deliberately mirrors what a
// hardware device would display — recipient, amount, network — because the
// operator's job is the same either way: confirm the money is going where they
// expect (D32).
//
// Spec: docs/architecture.md §4.3

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { PendingProposal } from "@cp/shared-types";

export function renderProposal(proposal: PendingProposal): string {
  const lines = [
    "",
    "  ┌─ CONFIRM PAYMENT ──────────────────────────────────",
    `  │ Recipient : ${proposal.vendorName}`,
    `  │ Address   : ${proposal.address}`,
    `  │ Amount    : ${proposal.amount} ${proposal.token}`,
    `  │ Network   : ${proposal.network}`,
    `  │ Invoice   : ${proposal.invoiceRef}`,
    `  │ Decision  : ${proposal.decision} (${proposal.decisionReasonCode})`,
    `  │ Settles   : ${proposal.settlementMode}`,
  ];

  if (proposal.settlementMode === "HTLC") {
    // Worth its own line. The operator is signing a lock, not a transfer, and
    // the money sits in escrow until the payee proves receipt or the deadline
    // returns it — a materially different thing to approve.
    lines.push("  │");
    lines.push("  │ ⓘ  SETTLES THROUGH ESCROW");
    lines.push("  │    The payee must reveal a secret to collect. Unclaimed funds return.");
  }

  if (proposal.isNewOrChangedAddress) {
    // The highest-risk case, called out rather than left for the operator to
    // infer from a reason code.
    lines.push("  │");
    lines.push("  │ ⚠  FIRST PAYMENT TO THIS ADDRESS");
    lines.push("  │    Send a test amount and confirm receipt before the full value.");
  }

  lines.push("  └────────────────────────────────────────────────────", "");
  return lines.join("\n");
}

/**
 * Requires the operator to type the amount back.
 *
 * A y/n prompt is answered reflexively. Re-typing the amount forces the one
 * number that matters to pass through their attention — the same reason a
 * hardware device shows it on its own screen instead of trusting the host.
 */
export async function confirmSend(proposal: PendingProposal): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      `  Type the amount (${proposal.amount}) to confirm, or anything else to cancel: `,
    );
    return answer.trim() === proposal.amount;
  } finally {
    rl.close();
  }
}

/** Password prompt for the local keystore. Never echoed, never stored. */
export async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question("  Keystore password: ");
  } finally {
    rl.close();
  }
}
