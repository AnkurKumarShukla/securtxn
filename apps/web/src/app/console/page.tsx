"use client";

// The flow console.
//
// One page that drives the entire flow against the real API and shows, per
// step, exactly what was sent and what came back. Its job is to make a failure
// LEGIBLE: which step, which status, which message — not "something went wrong".
//
// It does not mock anything. Every button is the same call a real client makes,
// in the order the services enforce, so a gate that is broken shows up here as
// a 4xx rather than as a silent pass.
//
// LEGACY — DO NOT COPY FROM THIS FILE, AND DO NOT RESTYLE IT.
//
// This page predates the product UI at `/app`. Every style below is an inline
// `React.CSSProperties` object over raw hex, and `STATE_COLOUR` is a private
// status map that contradicts `components/ui/status.ts`. It is scheduled for
// deletion once the standalone World ID surface it hosts is confirmed covered
// elsewhere. Until then it keeps working and nothing here changes — restyling a
// file you intend to delete is waste, and it tells the next person the file is
// current when it is not.
//
// Spec: docs/payment-flow.md

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STEPS, api, messageOf, senderSignal, type StepId, type StepRecord } from "../../lib/flow";
import { RUNNERS, StepError, freshContext, type RunContext } from "../../lib/runner";
import { LegacyBanner } from "../../components/ui/LegacyBanner";
import { WorldIdStep } from "./WorldIdStep";

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "296");

export default function ConsolePage() {
  // The run context holds a FRESHLY GENERATED payee key, so it must not be
  // built during render: "use client" components are still server-rendered, and
  // the server's key would differ from the client's. React then reports a
  // hydration mismatch and throws away the tree — with the key visible in the
  // sidebar, the mismatch is literally the address.
  //
  // Created in an effect instead, which only ever runs in the browser.
  const ctxRef = useRef<RunContext | null>(null);
  const [ready, setReady] = useState(false);
  const [, forceRender] = useState(0);
  const [records, setRecords] = useState<Record<string, StepRecord>>({});
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState<StepId | null>(null);
  // Mirrors ctx.amount so the treasury check re-runs when it is edited. The
  // context holds the value the runner reads; this drives the render.
  const [amount, setAmount] = useState("10.00");

  const repaint = useCallback(() => forceRender((n) => n + 1), []);

  useEffect(() => {
    ctxRef.current = freshContext(CHAIN_ID);
    setReady(true);
  }, []);

  const runStep = useCallback(
    async (id: StepId): Promise<boolean> => {
      setRecords((r) => ({ ...r, [id]: { state: "running" } }));
      const started = Date.now();
      try {
        const result = await RUNNERS[id](ctxRef.current!, (patch) =>
          setRecords((r) => ({ ...r, [id]: { ...(r[id] ?? { state: "running" }), ...patch } })),
        );
        setRecords((r) => ({
          ...r,
          [id]: {
            state: "ok",
            request: result.request,
            response: result.response,
            note: result.note,
            ms: Date.now() - started,
          },
        }));
        repaint();
        return true;
      } catch (error) {
        const isStepError = error instanceof StepError;
        setRecords((r) => ({
          ...r,
          [id]: {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
            response: isStepError ? error.call?.body : undefined,
            status: isStepError ? error.call?.status : undefined,
            ms: Date.now() - started,
          },
        }));
        repaint();
        return false;
      }
    },
    [repaint],
  );

  /** Runs from the top until something fails, so the first red row is the cause. */
  const runAll = useCallback(async () => {
    setRunning(true);
    setStopped(null);
    for (const step of STEPS) {
      const ok = await runStep(step.id);
      if (!ok) {
        setStopped(step.id);
        break;
      }
    }
    setRunning(false);
  }, [runStep]);

  /**
   * Downloads the whole run — every request, response, status and error.
   *
   * The point is that whoever hits a problem can send this back rather than a
   * screenshot of one red row. The payee's private key is deliberately NOT
   * included: the address identifies the run, and the key would let anyone
   * holding the file sign as that payee.
   */
  const exportLog = useCallback(() => {
    const c = ctxRef.current;
    if (!c) return;
    const payload = {
      capturedAt: new Date().toISOString(),
      apiBase: process.env.NEXT_PUBLIC_API_BASE_URL || "(same origin)",
      origin: typeof window === "undefined" ? null : window.location.origin,
      chainId: CHAIN_ID,
      context: {
        payerVendorId: c.payerVendorId,
        payeeVendorId: c.payeeVendorId,
        walletId: c.walletId,
        payeeAddress: c.payeeAddress,
        paymentId: c.paymentId,
        invoiceRef: c.invoiceRef,
        amount: c.amount,
        asset: c.asset,
        network: c.network,
        claimedName: c.claimedName,
        claimedPan: c.claimedPan,
        senderEnrolmentId: c.senderEnrolmentId,
        senderWorldIdId: c.senderWorldIdId,
      },
      steps: STEPS.map((step) => ({
        id: step.id,
        label: step.label,
        ...(records[step.id] ?? { state: "idle" }),
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flow-run-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [records]);

  const reset = useCallback(() => {
    ctxRef.current = freshContext(CHAIN_ID);
    setRecords({});
    setStopped(null);
    repaint();
  }, [repaint]);

  const phases = useMemo(() => {
    const order: string[] = [];
    for (const s of STEPS) if (!order.includes(s.phase)) order.push(s.phase);
    return order;
  }, []);

  const failed = stopped ? records[stopped] : null;

  // Nothing key-dependent is rendered until the effect above has run, so the
  // server and the first client render agree.
  if (!ready || !ctxRef.current) {
    return <main style={S.main}><p style={S.sub}>Preparing the run…</p></main>;
  }
  const ctx = ctxRef.current;

  return (
    <main style={S.main}>
      <LegacyBanner page="flow console" instead="/app" />
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Flow console</h1>
          <p style={S.sub}>
            Every step below calls the real API in the order the services enforce. Nothing is
            mocked — a broken gate shows up here as a 4xx.
          </p>
        </div>
        <div style={S.actions}>
          <button style={S.primary} onClick={runAll} disabled={running}>
            {running ? "Running…" : "Run from the top"}
          </button>
          <button style={S.ghost} onClick={exportLog} disabled={running}>
            Export log
          </button>
          <button style={S.ghost} onClick={reset} disabled={running}>
            Reset
          </button>
        </div>
      </header>

      {failed && (
        <div style={S.banner}>
          <strong>Stopped at “{STEPS.find((s) => s.id === stopped)?.label}”.</strong>{" "}
          {failed.error}
        </div>
      )}

      <section style={S.body}>
        <div style={S.steps}>
          {phases.map((phase) => (
            <div key={phase}>
              <h2 style={S.phase}>{phase}</h2>
              {STEPS.filter((s) => s.phase === phase).map((step) => (
                <StepRow
                  key={step.id}
                  id={step.id}
                  label={step.label}
                  proves={step.proves}
                  manual={step.manual}
                  record={records[step.id]}
                  disabled={running}
                  onRun={() => void runStep(step.id)}
                />
              ))}
            </div>
          ))}
        </div>

        <aside style={S.side}>
          <h2 style={S.phase}>Run context</h2>
          <Field k="Signing chain" v={`${CHAIN_ID}`} />
          <Field k="Sender vendor" v={ctx.payerVendorId} copy />
          <Field k="Payee vendor" v={ctx.payeeVendorId} copy />
          <Field k="Payee wallet row" v={ctx.walletId} copy />
          <Field k="Payee ADDRESS" v={ctx.payeeAddress || null} mono copy />
          <Field k="Network" v={ctx.network} />
          <Field k="Payment" v={ctx.paymentId} copy />
          <Field k="Invoice" v={ctx.invoiceRef} />
          <label style={S.label}>
            Amount
            <input
              style={S.input}
              defaultValue={ctx.amount}
              onChange={(e) => {
                ctx.amount = e.target.value.trim();
                setAmount(e.target.value.trim());
              }}
            />
          </label>
          <label style={S.label}>
            Asset
            <input
              style={S.input}
              defaultValue={ctx.asset}
              onChange={(e) => {
                ctx.asset = e.target.value.trim().toUpperCase();
              }}
            />
          </label>
          <label style={S.label}>
            Settlement
            <select
              style={S.input}
              defaultValue={ctx.settlementMode}
              onChange={(e) => {
                ctx.settlementMode = e.target.value as "DIRECT" | "HTLC";
              }}
            >
              <option value="DIRECT">DIRECT — send outright</option>
              <option value="HTLC">HTLC — lock in escrow</option>
            </select>
          </label>
          <OnChain amount={amount} asset={ctx.asset} payee={ctx.payeeAddress} />
          <h2 style={{ ...S.phase, marginTop: 24 }}>What the sender claims</h2>
          <p style={S.hint}>
            Change either of these to a wrong value and the decision should come back{" "}
            <code>REVERIFY / VENDOR_MATCH_FAILED</code> — that is the invoice-fraud demo.
          </p>
          <label style={S.label}>
            Intended payee name
            <input
              style={S.input}
              defaultValue={ctx.claimedName}
              onChange={(e) => {
                ctx.claimedName = e.target.value;
              }}
            />
          </label>
          <label style={S.label}>
            Intended payee PAN
            <input
              style={S.input}
              defaultValue={ctx.claimedPan}
              onChange={(e) => {
                ctx.claimedPan = e.target.value;
              }}
            />
          </label>

          <h2 style={{ ...S.phase, marginTop: 24 }}>World ID</h2>
          <p style={S.hint}>
            Real Selfie Checks, in order: enrol the payee first, then the two payment-time
            checks. The signal binds each proof to one payment, so a selfie taken for one
            cannot unlock another.
          </p>
          <Field k="Sender enrolment" v={ctx.senderEnrolmentId} />
          <Field k="Sender check" v={ctx.senderWorldIdId} />
          <div style={{ height: 10 }} />

          <WorldIdStep
            title="1 · Your enrolment (O7)"
            purpose="ENROLLMENT"
            signal={ctx.payerVendorId ? `enrol:${ctx.payerVendorId}` : ""}
            subject={ctx.payerVendorId ?? ""}
            onVerified={(id) => {
              ctx.senderEnrolmentId = id;
              repaint();
            }}
          />
          <WorldIdStep
            title="2 · Your check for this payment (P2)"
            purpose="REVERIFICATION"
            signal={ctx.paymentId ? senderSignal(ctx.paymentId) : ""}
            subject={ctx.payerVendorId ?? ""}
            onVerified={(id) => {
              ctx.senderWorldIdId = id;
              repaint();
            }}
          />

          <h2 style={{ ...S.phase, marginTop: 24 }}>The payee</h2>
          <p style={S.hint}>
            They onboard themselves at{" "}
            <a href="/payee" target="_blank" rel="noopener" style={S.openLink}>
              /payee
            </a>{" "}
            with their own DigiLocker account and their own key, then send you their vendor id.
            You never hold their key — that is what makes their acceptance mean anything.
          </p>
          <label style={S.label}>
            Payee vendor id
            <input
              style={S.input}
              placeholder="paste what they send you"
              defaultValue={ctx.payeeVendorId ?? ""}
              onChange={(e) => {
                ctx.payeeVendorId = e.target.value.trim() || null;
              }}
            />
          </label>
        </aside>
      </section>
    </main>
  );
}

function StepRow(props: {
  id: StepId;
  label: string;
  proves: string;
  manual?: boolean | undefined;
  record?: StepRecord | undefined;
  disabled: boolean;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  const state = props.record?.state ?? "idle";
  const colour = STATE_COLOUR[state];

  return (
    <div style={{ ...S.row, borderLeft: `3px solid ${colour}` }}>
      <div style={S.rowHead}>
        <button style={S.runBtn} onClick={props.onRun} disabled={props.disabled}>
          ▶
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.rowLabel}>
            {props.label}
            {props.manual && <span style={S.manual}>needs a human</span>}
          </div>
          <div style={S.proves}>{props.proves}</div>
          {props.record?.error && <div style={S.err}>{props.record.error}</div>}
          {props.record?.note && <div style={S.note}>{props.record.note}</div>}
          {props.record?.prompt && (
            <div style={S.prompt}>
              <input readOnly value={props.record.prompt} style={S.promptInput} />
              <button
                style={S.ghostSm}
                onClick={() => void navigator.clipboard.writeText(props.record!.prompt!)}
              >
                copy link
              </button>
              <a href={props.record.prompt} target="_blank" rel="noopener" style={S.openLink}>
                open
              </a>
            </div>
          )}
        </div>
        <div style={S.meta}>
          {props.record?.ms !== undefined && <span style={S.ms}>{props.record.ms}ms</span>}
          <span style={{ ...S.badge, background: colour }}>{state}</span>
          {(props.record?.response !== undefined || props.record?.request !== undefined) && (
            <button style={S.ghostSm} onClick={() => setOpen((v) => !v)}>
              {open ? "hide" : "json"}
            </button>
          )}
        </div>
      </div>
      {open && (
        <div style={S.json}>
          {props.record?.request !== undefined && (
            <>
              <div style={S.jsonLabel}>signed / sent</div>
              <pre style={S.pre}>{JSON.stringify(props.record.request, null, 2)}</pre>
            </>
          )}
          <div style={S.jsonLabel}>response</div>
          <pre style={S.pre}>{JSON.stringify(props.record?.response, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * What the paying treasury holds.
 *
 * Shown here because a payment settles by transferring FROM the treasury: if it
 * holds nothing the transfer reverts on chain, and without this the first sign
 * of that is a failed settlement at the very end of the flow.
 */
type AccountView = {
  label: string;
  evmAddress: string;
  hederaId: string | null;
  hbar: string | null;
  maxAutoAssociations: number | null;
  tokenBalance: string | null;
};

/**
 * Both sides of the transfer, on chain.
 *
 * Either side can make a payment impossible in a way nothing else shows: an
 * empty treasury, or a payee address that is not a Hedera account yet. Both
 * surface only when the transfer reverts, which is the last step of the flow —
 * so they are shown here, before anyone promises a payment.
 */
function OnChain({ amount, asset, payee }: { amount: string; asset: string; payee: string }) {
  const [data, setData] = useState<{
    asset: string;
    tokenAddress: string;
    payer: AccountView;
    payee: AccountView | null;
    canSend: boolean | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const query = new URLSearchParams({ asset: asset || "stUSDC", amount: amount || "0" });
    if (payee) query.set("payee", payee);
    // This panel stands on its own — it is not part of a run, so it has no
    // ctx.token to borrow and mints its own.
    const minted = await api("/api/token", {
      method: "POST",
      body: { role: "agent", subject: "flow-console-treasury" },
    });
    if (!minted.ok) {
      setError(messageOf(minted.body));
      setData(null);
      return;
    }
    const res = await api(`/treasury?${query.toString()}`, {
      token: (minted.body as { token: string }).token,
    });
    if (!res.ok) {
      setError(messageOf(res.body));
      setData(null);
      return;
    }
    setData(res.body as typeof data);
  }, [amount, asset, payee]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={S.onchain}>
      <div style={S.onchainHead}>
        <span style={S.phase}>On chain — {data?.asset ?? asset}</span>
        <button style={S.ghostSm} onClick={() => void load()}>
          refresh
        </button>
      </div>

      {error && <div style={S.warn}>{error}</div>}
      {data && (
        <>
          <Side view={data.payer} />
          {data.payee ? (
            <Side view={data.payee} />
          ) : (
            <div style={S.fieldHint}>Payee address unknown — run “Check the payee is ready”.</div>
          )}
          {data.canSend === false && (
            <div style={S.warn}>
              Treasury holds {data.payer.tokenBalance ?? "—"} {data.asset}; sending {amount} would
              revert.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Side({ view }: { view: AccountView }) {
  return (
    <div style={S.side2}>
      <div style={S.sideLabel}>{view.label}</div>
      <Field k="EVM" v={view.evmAddress} mono copy />
      <Field k="Hedera id" v={view.hederaId ?? "not an account yet"} copy={Boolean(view.hederaId)} />
      <Field k="HBAR" v={view.hbar} />
      <Field k="Balance" v={view.tokenBalance} />
      {view.maxAutoAssociations === 0 && (
        <div style={S.warn}>
          No auto-association slots — this account must associate the token before it can receive
          it.
        </div>
      )}
    </div>
  );
}

function Field({
  k,
  v,
  mono,
  copy,
}: {
  k: string;
  v: string | null;
  mono?: boolean;
  copy?: boolean;
}) {
  return (
    <div style={S.field}>
      <span style={S.fieldK}>{k}</span>
      <span style={{ ...S.fieldV, ...(mono ? { fontFamily: MONO } : {}) }}>{v ?? "—"}</span>
      {copy && v && (
        <button
          style={S.copyBtn}
          title="copy"
          onClick={() => void navigator.clipboard.writeText(v)}
        >
          ⧉
        </button>
      )}
    </div>
  );
}

const STATE_COLOUR: Record<string, string> = {
  idle: "#3f3f46",
  running: "#eab308",
  ok: "#22c55e",
  failed: "#ef4444",
  skipped: "#3f3f46",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 1280, margin: "0 auto", padding: "32px 24px 80px", color: "#e4e4e7" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24, marginBottom: 24 },
  h1: { fontSize: 26, fontWeight: 600, margin: 0 },
  sub: { color: "#a1a1aa", fontSize: 14, margin: "6px 0 0", maxWidth: 620, lineHeight: 1.5 },
  actions: { display: "flex", gap: 8, flexShrink: 0 },
  primary: { background: "#2563eb", color: "white", border: 0, borderRadius: 8, padding: "10px 16px", fontSize: 14, cursor: "pointer" },
  ghost: { background: "transparent", color: "#a1a1aa", border: "1px solid #3f3f46", borderRadius: 8, padding: "10px 16px", fontSize: 14, cursor: "pointer" },
  ghostSm: { background: "transparent", color: "#a1a1aa", border: "1px solid #3f3f46", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" },
  banner: { background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 14, lineHeight: 1.5 },
  body: { display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 28, alignItems: "start" },
  steps: { display: "flex", flexDirection: "column", gap: 20, minWidth: 0 },
  side: { position: "sticky", top: 24, background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 18 },
  phase: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#71717a", margin: "0 0 10px" },
  row: { background: "#18181b", border: "1px solid #27272a", borderRadius: 8, marginBottom: 8, overflow: "hidden" },
  rowHead: { display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 12px" },
  runBtn: { background: "#27272a", color: "#e4e4e7", border: 0, borderRadius: 6, width: 28, height: 28, cursor: "pointer", flexShrink: 0 },
  rowLabel: { fontSize: 14, fontWeight: 500, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  proves: { fontSize: 12.5, color: "#a1a1aa", marginTop: 3, lineHeight: 1.45 },
  manual: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", background: "#422006", color: "#fbbf24", padding: "2px 6px", borderRadius: 4 },
  err: { fontSize: 12.5, color: "#fca5a5", marginTop: 6, fontFamily: MONO, lineHeight: 1.5, wordBreak: "break-word" },
  note: { fontSize: 12, color: "#7dd3fc", marginTop: 6, lineHeight: 1.45 },
  meta: { display: "flex", gap: 8, alignItems: "center", flexShrink: 0 },
  ms: { fontSize: 11, color: "#71717a", fontFamily: MONO },
  badge: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "#09090b", padding: "2px 7px", borderRadius: 4, fontWeight: 600 },
  prompt: { display: "flex", gap: 6, alignItems: "center", marginTop: 8, flexWrap: "wrap" },
  promptInput: { flex: 1, minWidth: 180, background: "#09090b", border: "1px solid #3f3f46", borderRadius: 6, color: "#a1a1aa", padding: "5px 8px", fontSize: 11, fontFamily: MONO },
  openLink: { fontSize: 12, color: "#60a5fa", textDecoration: "none" },
  onchain: { marginTop: 14, paddingTop: 10, borderTop: "1px solid #3f3f46" },
  onchainHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  side2: { marginBottom: 12 },
  sideLabel: { fontSize: 11.5, color: "#e4e4e7", marginBottom: 4 },
  fieldHint: { fontSize: 11, color: "#71717a", lineHeight: 1.45, margin: "4px 0" },
  warn: { fontSize: 11.5, color: "#fbbf24", margin: "6px 0", lineHeight: 1.45 },
  json: { borderTop: "1px solid #27272a", padding: "10px 12px", background: "#09090b" },
  jsonLabel: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "#71717a", margin: "6px 0 4px" },
  pre: { fontSize: 11.5, fontFamily: MONO, color: "#d4d4d8", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto" },
  field: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #27272a", fontSize: 12.5 },
  copyBtn: { background: "transparent", border: 0, color: "#71717a", cursor: "pointer", fontSize: 13, padding: 0, flexShrink: 0 },
  fieldK: { color: "#71717a", flexShrink: 0 },
  fieldV: { color: "#e4e4e7", textAlign: "right", wordBreak: "break-all", minWidth: 0 },
  hint: { fontSize: 12, color: "#a1a1aa", lineHeight: 1.5, margin: "0 0 10px" },
  label: { display: "block", fontSize: 12, color: "#a1a1aa", marginBottom: 10 },
  input: { display: "block", width: "100%", marginTop: 4, background: "#09090b", border: "1px solid #3f3f46", borderRadius: 6, color: "#e4e4e7", padding: "7px 9px", fontSize: 12.5, fontFamily: MONO },
};
