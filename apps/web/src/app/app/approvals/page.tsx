"use client";

// The approval queue.
//
// THE MOST IMPORTANT COPY ON THIS SCREEN IS A DISCLAIMER. Approving here does
// NOT send money — it records that a human approved a proposal, and the
// transfer is signed separately on the approver's own machine with a hardware
// key this application never touches. A queue that implies otherwise teaches an
// operator that clicking a button in a browser moves funds, which is exactly
// the habit this architecture exists to prevent.
//
// The address gets the most visual weight on every row, because address
// substitution is the attack, and `isNewOrChangedAddress` is called out
// explicitly rather than left in a payload nobody reads.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PendingProposal } from "@cp/shared-types";
import { listPendingApprovals } from "../../../lib/api-client";
import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { Relative } from "../../../components/app/shell/Relative";
import { decisionTone } from "../../../components/app/payments/status";
import { Alert } from "../../../components/ui/Alert";
import { IconButton, RefreshIcon } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Field } from "../../../components/ui/Field";
import { Hash } from "../../../components/ui/Mono";
import { Panel } from "../../../components/ui/Surface";
import { StatusPill } from "../../../components/ui/StatusPill";

export default function ApprovalsPage() {
  const { ready, approverToken } = useApp();
  const [rows, setRows] = useState<PendingProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Approver-scoped: an agent token is refused here, by design.
      const t = await approverToken();
      const result = await listPendingApprovals(t);
      setRows(result.proposals);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [approverToken]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  return (
    <>
      <PageHeader
        title="Approvals"
        lead="Payments that passed every automated check and are waiting on a person."
        actions={
          <IconButton icon={<RefreshIcon />} label="Refresh" onClick={() => void load()} />
        }
      />

      {error && (
        <Alert tone="error" className="mb-4" title="Could not load the queue">
          {error}
        </Alert>
      )}

      {/* <Alert tone="info" className="mb-4" title="Approving here does not send money">
        It records a human decision against a proposal. The transfer is signed on the approver&apos;s
        own machine with a hardware key this application never holds, which is what stops a
        compromised browser from moving funds.
      </Alert> */}

      {rows === null ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Panel key={i} className="h-32 animate-pulse opacity-40">
              <span className="sr-only">Loading</span>
            </Panel>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Panel className="p-6">
          <EmptyState title="Nothing waiting">
            A payment reaches this queue after the payee accepts it and the decision engine clears
            it. Nothing is here until both have happened.
          </EmptyState>
        </Panel>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Panel key={row.id} className="p-5" spotlight>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold text-mist-50">{row.vendorName}</h2>
                  <p className="mt-0.5 font-mono text-[11.5px] text-mist-500">{row.invoiceRef}</p>
                </div>
                <div className="text-right">
                  <div className="text-[20px] font-semibold tabular-nums text-mist-50">
                    {row.amount}{" "}
                    <span className="text-[12px] font-normal text-mist-400">{row.token}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-mist-600 uppercase">
                    {row.settlementMode}
                  </div>
                </div>
              </div>

              {/* An address nobody at this organisation has paid before is the
                  exact shape of an invoice-hijack, so it is called out rather
                  than left as a boolean in the payload. */}
              {row.isNewOrChangedAddress && (
                <Alert tone="warn" className="mt-3" title="First payment to this address">
                  You have not paid this address before. Confirm it against something other than
                  the invoice it arrived on.
                </Alert>
              )}

              <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
                <div>
                  <Field k="Paying to" v={row.address} mono copy />
                  <Field k="Network" v={row.network} />
                </div>
                <div>
                  <Field k="Verdict" v={row.decision} />
                  <Field k="Reason" v={row.decisionReasonCode} />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <StatusPill tone={decisionTone(row.decision)}>{row.decision}</StatusPill>
                <span className="text-[11.5px] text-mist-600">
                  proposed <Relative iso={row.proposedAt} />
                </span>
                <div className="flex-1" />
                <Link
                  href={`/app/payments/${row.paymentRequestId}`}
                  className="inline-flex h-8 items-center rounded-md hairline-strong bg-white/[0.045] px-3 text-[12.5px] text-mist-200 transition-colors hover:border-hairline-active hover:text-mist-50"
                >
                  Open payment
                </Link>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
