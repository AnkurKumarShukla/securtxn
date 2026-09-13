// Typed reads for the product screens.
// Spec: docs/architecture.md 2
//
// `lib/flow.ts`'s `api()` is still the transport — it is the one that keeps an
// error body verbatim, which during integration is the entire diagnostic value.
// This adds the shapes the list screens need on top of it, so a page does not
// cast an `unknown` body inline and quietly disagree with the next page about
// what a payment row looks like.

import type {
  PendingProposalList,
  PaymentList,
  PaymentListQuery,
  PaymentSummary,
  VendorList,
  VendorListQuery,
  VendorSummary,
} from "@cp/shared-types";
import { api, messageOf } from "./flow";

/** Throws with the API's own message, which is always more useful than ours. */
async function read<T>(path: string, token: string | null): Promise<T> {
  const call = await api(path, { token });
  if (!call.ok) throw new Error(messageOf(call.body));
  return call.body as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export function listPayments(
  token: string | null,
  params: Partial<PaymentListQuery> = {},
): Promise<PaymentList> {
  return read<PaymentList>(`/payments${query(params)}`, token);
}

export function getPayment(token: string | null, id: string): Promise<PaymentSummary> {
  return read<PaymentSummary>(`/payments/${id}`, token);
}

export function listVendors(
  token: string | null,
  params: Partial<VendorListQuery> = {},
): Promise<VendorList> {
  return read<VendorList>(`/vendors${query(params)}`, token);
}

export function getVendor(token: string | null, id: string): Promise<VendorSummary> {
  return read<VendorSummary>(`/vendors/${id}`, token);
}

/** The approval queue. Already existed; it was simply never rendered. */
export function listPendingApprovals(token: string | null): Promise<PendingProposalList> {
  return read<PendingProposalList>("/approvals/pending", token);
}

export type AnchorRow = {
  id: string;
  merkleRoot: string;
  recordCount: number;
  topicId: string | null;
  sequenceNumber: number | null;
  consensusTimestamp: string | null;
  transactionId: string | null;
  messageUrl: string | null;
  verified: boolean;
  createdAt: string;
};

export function listAnchors(token: string | null): Promise<AnchorRow[]> {
  return read<AnchorRow[]>("/evidence/anchors", token);
}

export type EvidenceRecord = {
  id: string;
  eventType: string;
  payload: unknown;
  payloadHash: string;
  previousRecordHash: string | null;
  hcsAnchorTxId: string | null;
  createdAt: string;
};

export type EvidenceChain = {
  paymentRequestId: string;
  records: EvidenceRecord[];
  chainValid: boolean;
  brokenAtIndex: number | null;
};

export function getEvidence(token: string | null, paymentId: string): Promise<EvidenceChain> {
  return read<EvidenceChain>(`/payments/${paymentId}/evidence`, token);
}

export type SettlementRow = {
  paymentRequestId: string;
  mode: string;
  status: string;
  escrowAddress: string;
  lockId: string;
  hashlock: string;
  timelock: string;
  payerAddress: string;
  payeeAddress: string;
  /** The escrowed token's contract — needed to re-derive the lock id. */
  tokenAddress: string;
  amount: string;
  /** The same amount as the chain saw it, which is what the lock id is over. */
  onChainAmount: string;
  /** Null while PENDING_LOCK: the payer has not sent the transaction yet. */
  lockTxHash: string | null;
  claimTxHash: string | null;
  refundTxHash: string | null;
};

/** 404 here is not an error: a DIRECT payment simply has no escrow. */
export async function getSettlement(
  token: string | null,
  paymentId: string,
): Promise<SettlementRow | null> {
  const call = await api(`/payments/${paymentId}/settlement`, { token });
  if (call.status === 404) return null;
  if (!call.ok) throw new Error(messageOf(call.body));
  return call.body as SettlementRow;
}
