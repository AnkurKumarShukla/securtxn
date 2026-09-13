"use client";

// The overview.
//
// Built around one question: WHAT NEEDS ME? Everything else on this screen is
// context for that. So the tiles are counts of payments blocked on somebody,
// each one a link into the list already filtered, and the first thing rendered
// is whatever is actually wrong.
//
// It is not a chart. A payment either needs attention or it does not, and
// plotting five of them over time tells nobody anything they can act on.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PaymentListItem, PendingProposalList } from "@cp/shared-types";
import { listPayments, listPendingApprovals } from "../../lib/api-client";
import { useApp } from "../../components/app/AppProvider";
import { PageHeader, Stat } from "../../components/app/shell/Page";
import { Relative } from "../../components/app/shell/Relative";
import { statusMeta } from "../../components/app/payments/status";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Panel } from "../../components/ui/Surface";
import { StatusPill } from "../../components/ui/StatusPill";

export default function OverviewPage() {
  const { ready, org, orgReady, token, approverToken, payee } = useApp();
  const [rows, setRows] = useState<PaymentListItem[] | null>(null);
  const [approvals, setApprovals] = useState<PendingProposalList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await token();
      const [payments, pending] = await Promise.all([
        listPayments(t, {
          ...(org.vendorId ? { payerVendorId: org.vendorId } : {}),
          limit: 100,
        }),
        // Approver-scoped, and a separate token. A failure here must not
        // blank the rest of the overview.
        approverToken()
          .then(listPendingApprovals)
          .catch(() => ({ proposals: [] }) as PendingProposalList),
      ]);
      setRows(payments.items);
      setApprovals(pending);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [token, approverToken, org.vendorId]);

  useEffect(() => {
    if (ready && orgReady) void load();
  }, [ready, orgReady, load]);

  // Setup is not optional, so it is the whole screen rather than a banner
  // somebody scrolls past.
  if (ready && !orgReady) {
    return (
      <>
        <PageHeader
          title="Welcome to SecurTxn"
          lead="A control layer in front of stablecoin payouts. Before you can raise one, the platform has to know who is paying."
        />
        <Panel className="p-6" spotlight>
          <h2 className="text-[16px] font-semibold text-mist-50">Set up your organisation</h2>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-mist-400">
            Three things, once: a record for your company, a DigiLocker consent that establishes
            who you legally are, and a World ID enrolment so every later payment can confirm the
            same human raised it. It takes a few minutes and you never do it again.
          </p>
          <Link
            href="/app/account"
            className="mt-5 inline-flex h-9 items-center rounded-md bg-linear-to-b from-signal-400 to-signal-600 px-4 text-[13px] font-medium text-ink-950 shadow-[0_1px_0_0_rgba(255,255,255,0.40)_inset] transition-[filter] hover:brightness-[1.06]"
          >
            Start setup
          </Link>
        </Panel>
      </>
    );
  }

  const count = (predicate: (r: PaymentListItem) => boolean) =>
    rows ? rows.filter(predicate).length : 0;

  const awaitingPayee = count((r) => r.status === "AWAITING_PAYEE_CONSENT");
  const needsCheck = count((r) => r.status === "DECISION_PENDING");
  const blocked = count((r) => r.status === "EXCEPTION" || r.decision === "DO_NOT_SEND");
  const pendingApprovals = approvals?.proposals.length ?? 0;

  // What the operator can actually do something about, most urgent first.
  const attention = (rows ?? []).filter(
    (r) =>
      r.status === "DRAFT" ||
      r.status === "DECISION_PENDING" ||
      r.status === "EXCEPTION" ||
      r.decision === "DO_NOT_SEND",
  );

  return (
    <>
      <PageHeader
        title={org.displayName ?? "Overview"}
        lead="What has been raised, and what is waiting on somebody."
        actions={
          <>
            <Button variant="quiet" onClick={() => void load()}>
              Refresh
            </Button>
            <Link
              href="/app/payments/new"
              className="inline-flex h-9 items-center rounded-md bg-linear-to-b from-signal-400 to-signal-600 px-4 text-[13px] font-medium text-ink-950 shadow-[0_1px_0_0_rgba(255,255,255,0.40)_inset] transition-[filter] hover:brightness-[1.06]"
            >
              New payment
            </Link>
          </>
        }
      />

      {error && (
        <Alert tone="error" className="mb-4" title="Could not load your payments">
          {error}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Awaiting payee"
          value={awaitingPayee}
          sub="they accept from their own browser"
          tone={awaitingPayee > 0 ? "warn" : "default"}
          href="/app/payments"
        />
        <Stat
          label="Ready to check"
          value={needsCheck}
          sub="the payee accepted — run the match"
          tone={needsCheck > 0 ? "warn" : "default"}
          href="/app/payments"
        />
        <Stat
          label="Awaiting approval"
          value={pendingApprovals}
          sub="a human stands before the money"
          tone={pendingApprovals > 0 ? "warn" : "default"}
          href="/app/approvals"
        />
        <Stat
          label="Blocked"
          value={blocked}
          sub="refused, and the reason is recorded"
          tone={blocked > 0 ? "halt" : "default"}
          href="/app/payments"
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between hairline-b px-4 py-3">
            <h2 className="text-[13.5px] font-semibold text-mist-50">Needs you</h2>
            <Link href="/app/payments" className="text-[12px] text-signal-400 hover:text-signal-300">
              All payments
            </Link>
          </div>

          {rows === null ? (
            <div className="space-y-2 p-4">
              {[0, 1].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-white/[0.04]" />
              ))}
            </div>
          ) : attention.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nothing waiting on you">
                {rows.length === 0
                  ? "No payments yet. Raise one and it will appear here."
                  : "Everything raised is either with the payee, with an approver, or done."}
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {attention.slice(0, 8).map((row) => {
                const meta = statusMeta(row.status);
                return (
                  <li key={row.id}>
                    <Link
                      href={`/app/payments/${row.id}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors duration-[--dur-fast] hover:bg-white/[0.025]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-mist-50">
                          {row.payeeName ?? "Unnamed payee"}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-mist-500">
                          {row.invoiceRef}
                        </div>
                      </div>
                      <span className="shrink-0 text-[13px] font-semibold tabular-nums text-mist-100">
                        {row.amount} <span className="text-[10.5px] text-mist-500">{row.token}</span>
                      </span>
                      <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="space-y-4">
          {/* The other half of the demo. Payments arrive for the payee whether
              or not anyone is looking at that tab, so the count belongs here. */}
          {payee.incoming.length > 0 && (
            <Alert
              tone="warn"
              title={`${payee.incoming.length} payment${payee.incoming.length === 1 ? "" : "s"} waiting for you as a payee`}
            >
              Switch to Getting paid in the sidebar to accept or refuse them.
            </Alert>
          )}

          <Panel className="overflow-hidden">
            <div className="hairline-b px-4 py-3">
              <h2 className="text-[13.5px] font-semibold text-mist-50">Recent</h2>
            </div>
            {rows === null || rows.length === 0 ? (
              <p className="px-4 py-5 text-[12px] text-mist-600">Nothing yet.</p>
            ) : (
              <ul className="divide-y divide-hairline">
                {rows.slice(0, 6).map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/app/payments/${row.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-[12px] transition-colors duration-[--dur-fast] hover:bg-white/[0.025]"
                    >
                      <span className="min-w-0 truncate text-mist-300">
                        {row.payeeName ?? row.invoiceRef}
                      </span>
                      <span className="shrink-0 text-mist-600">
                        <Relative iso={row.createdAt} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
