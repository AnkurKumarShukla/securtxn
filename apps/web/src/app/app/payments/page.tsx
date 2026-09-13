"use client";

// The payments list.
//
// Sorted newest first and filterable by state, because the two questions this
// screen answers are "what happened to the one I raised" and "what is stuck".
// The second is why every row carries a WAITING ON line rather than only a
// status chip: `AWAITING_PAYEE_CONSENT` is precise and tells nobody whose move
// it is.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaymentListItem } from "@cp/shared-types";
import { listPayments } from "../../../lib/api-client";
import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { statusMeta } from "../../../components/app/payments/status";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Panel } from "../../../components/ui/Surface";
import { StatusPill } from "../../../components/ui/StatusPill";
import { Relative } from "../../../components/app/shell/Relative";

const FILTERS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "AWAITING_PAYEE_CONSENT", label: "Awaiting payee" },
  { value: "DECISION_PENDING", label: "Ready to check" },
  { value: "AWAITING_APPROVAL", label: "Awaiting approval" },
  { value: "SENT", label: "Sent" },
  { value: "EXCEPTION", label: "Blocked" },
] as const;

export default function PaymentsPage() {
  const { token, ready, org } = useApp();
  const [rows, setRows] = useState<PaymentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setError(null);

    // NO ACCOUNT, NO LIST. The filter used to be conditional, so a browser with
    // no account sent no filter at all — and the API answers an unfiltered
    // request with every payment on the server, including counterparties'.
    // Clearing your session showed you other people's payments, which is the
    // opposite of what losing your identity should do.
    if (!org.vendorId) {
      setRows([]);
      return;
    }

    try {
      const t = await token();
      const result = await listPayments(t, {
        ...(status ? { status: status as PaymentListItem["status"] } : {}),
        payerVendorId: org.vendorId,
        limit: 100,
      });
      setRows(result.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [token, status, org.vendorId]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  // Filtering the fetched page rather than round-tripping: the search is over
  // invoice and payee name, both already on the row, and a request per
  // keystroke would be worse on every axis.
  const visible = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.invoiceRef.toLowerCase().includes(needle) ||
        (r.payeeName ?? "").toLowerCase().includes(needle),
    );
  }, [rows, q]);

  return (
    <>
      <PageHeader
        title="Payments"
        lead="Every payout this organisation has raised, and whose move it is now."
        actions={
          <>
            <Button variant="quiet" onClick={() => void load()}>
              Refresh
            </Button>
            <Link
              href="/app/payments/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-linear-to-b from-signal-400 to-signal-600 px-4 text-[13px] font-medium text-ink-950 shadow-[0_1px_0_0_rgba(255,255,255,0.40)_inset] transition-[filter] hover:brightness-[1.06]"
            >
              New payment
            </Link>
          </>
        }
      />

      {error && (
        <Alert tone="error" className="mb-4" title="Could not load payments">
          {error}
        </Alert>
      )}

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 hairline-b p-3">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatus(f.value)}
                className={`rounded-xs px-2.5 py-1 text-[12px] transition-colors duration-[--dur-fast] ${
                  status === f.value
                    ? "bg-signal-500/15 text-signal-300"
                    : "text-mist-500 hover:bg-white/[0.04] hover:text-mist-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search invoice or payee"
            className="well w-full px-2.5 py-1.5 text-[12.5px] text-mist-100 placeholder:text-mist-600 sm:w-56"
          />
        </div>

        {visible === null ? (
          <LoadingRows />
        ) : visible.length === 0 ? (
          <div className="p-6">
            {/* Three different reasons for an empty table, and they are not
                interchangeable. "No account" is not "no payments" — saying the
                latter would imply the list is complete when it was never
                asked for. */}
            <EmptyState
              title={
                !org.vendorId
                  ? "No account yet"
                  : rows?.length
                    ? "Nothing matches"
                    : "No payments yet"
              }
            >
              {!org.vendorId ? (
                <>
                  Payments belong to an account. Set yours up on{" "}
                  <Link href="/app/account" className="text-signal-400 underline underline-offset-4">
                    Account
                  </Link>{" "}
                  and the ones you raise will appear here.
                </>
              ) : rows?.length ? (
                "Try a different filter or search term."
              ) : (
                "Raise one from New payment. You will need the payee's vendor id, which they get after onboarding on their own side."
              )}
            </EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {visible.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function Row({ row }: { row: PaymentListItem }) {
  const meta = statusMeta(row.status);

  return (
    <li>
      <Link
        href={`/app/payments/${row.id}`}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-colors duration-[--dur-fast] hover:bg-white/[0.025]"
      >
        <div className="min-w-0 flex-1 basis-48">
          <div className="truncate text-[13.5px] font-medium text-mist-50">
            {row.payeeName ?? "Unnamed payee"}
          </div>
          <div className="mt-0.5 font-mono text-[11.5px] text-mist-500">{row.invoiceRef}</div>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-[14px] font-semibold tabular-nums text-mist-50">
            {row.amount} <span className="text-[11.5px] font-normal text-mist-400">{row.token}</span>
          </div>
          <div className="mt-0.5 font-mono text-[10.5px] text-mist-600 uppercase">
            {row.settlementMode}
          </div>
        </div>

        <div className="min-w-0 basis-full sm:basis-56">
          <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          {meta.waitingOn && (
            <div className="mt-1 truncate text-[11px] text-mist-500">Waiting on {meta.waitingOn}</div>
          )}
        </div>

        <div className="shrink-0 text-right text-[11.5px] text-mist-500">
          <Relative iso={row.createdAt} />
        </div>
      </Link>
    </li>
  );
}

function LoadingRows() {
  return (
    <ul className="divide-y divide-hairline">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-4">
          <div className="h-8 flex-1 animate-pulse rounded bg-white/[0.04]" />
          <div className="h-8 w-24 animate-pulse rounded bg-white/[0.04]" />
        </li>
      ))}
    </ul>
  );
}
