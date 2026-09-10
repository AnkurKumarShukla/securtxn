// Which settlement mode suits a decision.
//
// ADVISORY, AND DELIBERATELY SEPARATE FROM `decide`. The decision engine
// answers whether money may move; this answers how it should travel. Folding
// the two together would make an escrow feel like an extra approval gate, and
// the whole point of D41 is that HTLC is a settlement choice, never a
// replacement for the decision.
//
// It is also a recommendation the caller may ignore. Some payees cannot claim —
// a custody desk with no key on the payout address, a counterparty who simply
// will not transact — and forcing an escrow on them would strand the payment
// for the timelock and then bounce it back. The safe default has to be the mode
// that always pays.
//
// Spec: docs/architecture.md §4.1, §4.5

import type { DecisionReasonCode, SettlementMode } from "@cp/shared-types";

/**
 * HTLC for a first payment to an address, DIRECT otherwise.
 *
 * NEW_OR_CHANGED_ADDRESS is exactly the case the escrow is for: every check
 * passed, and the only remaining risk is that this address is not who the
 * platform believes it is. That is unfalsifiable before the send and obvious
 * after it — unless the payee has to prove receipt to collect, and the funds
 * come back when they cannot.
 *
 * Every other outcome either blocks the payment or names a payee already paid
 * at this address before, where a plain transfer carries its own history.
 */
export function recommendSettlementMode(reasonCode: DecisionReasonCode): SettlementMode {
  return reasonCode === "NEW_OR_CHANGED_ADDRESS" ? "HTLC" : "DIRECT";
}
