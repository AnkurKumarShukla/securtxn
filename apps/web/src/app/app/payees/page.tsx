"use client";

// The payee directory.
//
// One column carries the whole meaning: CAN THEY BE PAID. A counterparty is
// payable only when they hold a wallet somebody has proved control of, bound to
// their DigiLocker identity, and confirmed out of band on a contact the
// registry already knew. Three independent gates, and the directory is the only
// place a person sees the answer before raising a payment against it.
//
// Deliberately thin on identity. The Aadhaar last-4 and the document checks are
// on the record itself, read one at a time; a browsable list is the wrong place
// to spray them.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { VendorListItem } from "@cp/shared-types";
import { listVendors } from "../../../lib/api-client";
import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { Relative } from "../../../components/app/shell/Relative";
import { Alert } from "../../../components/ui/Alert";
import { IconButton, RefreshIcon } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Hash } from "../../../components/ui/Mono";
import { Panel } from "../../../components/ui/Surface";
import { StatusPill } from "../../../components/ui/StatusPill";

export default function PayeesPage() {
  const { ready, token, org } = useApp();
  const [rows, setRows] = useState<VendorListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [payableOnly, setPayableOnly] = useState(false);

  const load = useCallback(async () => {
    setError(null);

    // The directory is who YOU can pay, which is a question with no answer
    // until there is a you. Listing every vendor to a browser with no account
    // is not a neutral default: it hands a stranger the counterparty list.
    if (!org.vendorId) {
      setRows([]);
      return;
    }

    try {
      const t = await token();
      const result = await listVendors(t, { limit: 200, ...(payableOnly ? { payableOnly: true } : {}) });
      // Your own account is not a counterparty you can pay. Filtered client-side
      // because the API has no "everyone but me" query — and it is one row.
      setRows(result.items.filter((v) => v.id !== org.vendorId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [token, payableOnly, org.vendorId]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const visible = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) => r.displayName.toLowerCase().includes(needle) || r.id.includes(needle),
    );
  }, [rows, q]);

  return (
    <>
      <PageHeader
        title="Payees"
        lead="Who you can pay, and how far each of them got through their own checks."
        actions={
          <IconButton icon={<RefreshIcon />} label="Refresh" onClick={() => void load()} />
        }
      />

      {error && (
        <Alert tone="error" className="mb-4" title="Could not load payees">
          {error}
        </Alert>
      )}

      <Alert tone="info" className="mb-4">
        You do not onboard a payee. They do it themselves, from their own browser, with their own
        DigiLocker account and a key you never hold — which is the only reason their acceptance of
        a payment means anything.
      </Alert>

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 hairline-b p-3">
          <label className="flex items-center gap-2 text-[12.5px] text-mist-400">
            <input
              type="checkbox"
              checked={payableOnly}
              onChange={(e) => setPayableOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-signal-500)]"
            />
            Payable only
          </label>
          <div className="flex-1" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or vendor id"
            className="well w-full px-2.5 py-1.5 text-[12.5px] text-mist-100 placeholder:text-mist-600 sm:w-60"
          />
        </div>

        {visible === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-white/[0.04]" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title={
                !org.vendorId
                  ? "No account yet"
                  : rows?.length
                    ? "Nothing matches"
                    : "No counterparties yet"
              }
            >
              {!org.vendorId ? (
                <>
                  Who you can pay depends on who you are. Set your account up on{" "}
                  <Link href="/app/account" className="text-signal-400 underline underline-offset-4">
                    Account
                  </Link>{" "}
                  first.
                </>
              ) : rows?.length ? (
                "Try a different search term, or clear the payable filter."
              ) : (
                "A counterparty appears here once they have onboarded on their own side, in their own browser with their own wallet."
              )}
            </EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {visible.map((row) => {
              const payable = row.walletStatus === "CONFIRMED";
              return (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5"
                >
                  <div className="min-w-0 flex-1 basis-52">
                    <div className="truncate text-[13.5px] font-medium text-mist-50">
                      {row.displayName || "Unnamed"}
                    </div>
                    <div className="mt-0.5">
                      {row.payoutAddress ? (
                        <Hash value={row.payoutAddress} chars={8} />
                      ) : (
                        <span className="text-[11.5px] text-mist-600">no confirmed address</span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0">
                    <StatusPill
                      tone={row.verificationTier === "TIER0_UNVERIFIED" ? "waiting" : "ok"}
                    >
                      {row.verificationTier.replace("TIER", "tier ").replace("_", " ").toLowerCase()}
                    </StatusPill>
                  </div>

                  <div className="shrink-0">
                    <StatusPill tone={payable ? "ok" : "waiting"}>
                      {payable ? "payable" : (row.walletStatus?.toLowerCase() ?? "no wallet")}
                    </StatusPill>
                  </div>

                  <div className="shrink-0 text-[11.5px] text-mist-600">
                    <Relative iso={row.createdAt} />
                  </div>

                  <div className="shrink-0">
                    {payable ? (
                      <Link
                        href="/app/payments/new"
                        className="inline-flex h-7 items-center rounded-md hairline-strong bg-white/[0.045] px-2.5 text-[12px] text-mist-200 transition-colors hover:border-hairline-active hover:text-mist-50"
                      >
                        Pay
                      </Link>
                    ) : (
                      <span className="text-[11.5px] text-mist-600">not yet</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
