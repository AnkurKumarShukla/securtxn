"use client";

// The audit trail.
//
// The claim this screen has to make good on is "verify it without asking us".
// Every payment writes a hash-linked record per step; batches of those records
// are hashed into a Merkle root and published to a Hedera consensus topic that
// nobody, including us, can rewrite.
//
// So the useful thing here is not a log — it is the ANCHOR, with its topic and
// sequence number, because that is what somebody who does not trust us can go
// and look up themselves. Each anchor links out to the public record.

import { useCallback, useEffect, useState } from "react";
import { api, messageOf } from "../../../lib/flow";
import { listAnchors, type AnchorRow } from "../../../lib/api-client";
import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { Relative } from "../../../components/app/shell/Relative";
import { Alert } from "../../../components/ui/Alert";
import { Button, IconButton, RefreshIcon } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Field } from "../../../components/ui/Field";
import { Hash } from "../../../components/ui/Mono";
import { Panel } from "../../../components/ui/Surface";
import { StatusPill } from "../../../components/ui/StatusPill";

export default function AuditPage() {
  const { ready, token } = useApp();
  const [rows, setRows] = useState<AnchorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await token();
      setRows(await listAnchors(t));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [token]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  /**
   * Reads an anchor back from a mirror node and checks the root matches.
   *
   * Offered per row because the flag is about OUR read-back, not about the
   * anchor: a mirror that has not caught up yet leaves a perfectly good anchor
   * marked unverified, and until now there was no way to ask again.
   */
  const verify = useCallback(
    async (id: string) => {
      setVerifying(id);
      setError(null);
      setNote(null);
      try {
        const t = await token();
        const call = await api(`/evidence/anchors/${id}/verify`, {
          method: "POST",
          token: t,
          body: {},
        });
        if (!call.ok) throw new Error(messageOf(call.body));
        setNote("Read back from a mirror node — the published root matches ours.");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setVerifying(null);
      }
    },
    [token, load],
  );

  /** Publishes a Merkle root over everything written since the last anchor. */
  const anchor = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const t = await token();
      const call = await api("/evidence/anchor", { method: "POST", token: t, body: {} });
      if (!call.ok) throw new Error(messageOf(call.body));
      const body = call.body as { recordsAnchored?: number; broadcast?: boolean };
      setNote(
        body.recordsAnchored === 0
          ? "Nothing new to anchor — every record is already published."
          : `Anchored ${body.recordsAnchored} record(s)${body.broadcast === false ? ", but the topic was not reachable" : ""}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [token, load]);

  return (
    <>
      <PageHeader
        title="Audit"
        lead="Every step of every payment is hash-linked, and the roots are published where nobody can rewrite them."
        actions={
          <>
            <IconButton icon={<RefreshIcon />} label="Refresh" onClick={() => void load()} />
            <Button variant="primary" onClick={() => void anchor()} busy={busy}>
              Publish an anchor
            </Button>
          </>
        }
      />

      {error && (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      )}
      {note && (
        <Alert tone="info" className="mb-4">
          {note}
        </Alert>
      )}

      <Alert tone="info" className="mb-4" title="Why this is worth anything">
        A log we keep is a log we could edit. Each record hashes the one before it, so a removal or
        an edit breaks the chain visibly; the root of a batch is then written to a public consensus
        topic. Anyone can recompute the chain and check it against that root without trusting us,
        and without us being online.
      </Alert>

      {rows === null ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Panel key={i} className="h-28 animate-pulse opacity-40">
              <span className="sr-only">Loading</span>
            </Panel>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Panel className="p-6">
          <EmptyState title="Nothing anchored yet">
            Records are written as payments progress. Publish an anchor to put their Merkle root on
            the public topic.
          </EmptyState>
        </Panel>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Panel key={row.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[14px] font-semibold text-mist-50">
                      {row.recordCount} record{row.recordCount === 1 ? "" : "s"}
                    </h2>
                    <StatusPill tone={row.verified ? "ok" : "waiting"}>
                      {row.verified ? "verified" : "unverified"}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-[11.5px] text-mist-500">
                    anchored <Relative iso={row.createdAt} />
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                {!row.verified && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void verify(row.id)}
                    busy={verifying === row.id}
                    disabled={verifying !== null && verifying !== row.id}
                  >
                    Verify
                  </Button>
                )}
                {row.messageUrl && (
                  <a
                    href={row.messageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md hairline-strong bg-white/[0.045] px-3 text-[12.5px] text-mist-200 transition-colors hover:border-hairline-active hover:text-mist-50"
                  >
                    Check it yourself
                    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M6 3.5h6.5V10M12.5 3.5 4 12" />
                    </svg>
                  </a>
                )}
                </div>
              </div>

              <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
                <div>
                  <Field k="Topic" v={row.topicId} copy />
                  <Field k="Sequence" v={row.sequenceNumber !== null ? String(row.sequenceNumber) : null} />
                </div>
                <div>
                  <Field k="Consensus at" v={row.consensusTimestamp} />
                  <Field k="Transaction" v={row.transactionId} mono copy />
                </div>
              </div>

              <div className="mt-3 hairline-t pt-3">
                <span className="mb-1 block font-mono text-[10px] tracking-[0.14em] text-mist-600 uppercase">
                  Merkle root
                </span>
                <Hash value={row.merkleRoot} chars={12} />
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
