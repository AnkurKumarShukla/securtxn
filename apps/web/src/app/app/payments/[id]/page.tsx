"use client";

// One payment, end to end.
//
// This screen replaces the sixteen-row control panel. The steps did not go
// away — they are the timeline, read off the payment's own status rather than
// off a local record of which buttons somebody pressed. The difference matters:
// the timeline is true on a fresh browser, and the control panel was not.
//
// Whatever is actionable right now is pulled to the top as ONE button. The rest
// is history. The raw request and response for anything the screen ran are kept
// under Technical, because a demo that cannot show the actual 4xx is a demo
// that asks to be trusted.

import { use, useCallback, useEffect, useState } from "react";
import type { PaymentSummary } from "@cp/shared-types";
import { api, messageOf } from "../../../../lib/flow";
import {
  getEvidence,
  getPayment,
  getSettlement,
  type EvidenceChain,
  type SettlementRow,
} from "../../../../lib/api-client";
import { useApp } from "../../../../components/app/AppProvider";
import { fundEscrow, preparedFromSettlement } from "../../../../lib/fundEscrow";
import { metamaskSigner } from "../../../../lib/wallet";
import type { PreparedLock } from "@cp/shared-types";
import { PageHeader } from "../../../../components/app/shell/Page";
import { Relative } from "../../../../components/app/shell/Relative";
import { deriveStages } from "../../../../components/app/payments/timeline";
import { statusMeta } from "../../../../components/app/payments/status";
import { Alert } from "../../../../components/ui/Alert";
import { Button, IconButton, RefreshIcon } from "../../../../components/ui/Button";
import { Field } from "../../../../components/ui/Field";
import { Code, Hash } from "../../../../components/ui/Mono";
import { JsonDrawer } from "../../../../components/ui/JsonDrawer";
import { Panel } from "../../../../components/ui/Surface";
import { StatusPill, Verdict } from "../../../../components/ui/StatusPill";
import { StepGlyph } from "../../../../components/ui/StepGlyph";

type Ran = { label: string; request?: unknown; response?: unknown; ms: number; ok: boolean };

export default function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, ready } = useApp();

  const [payment, setPayment] = useState<PaymentSummary | null>(null);
  const [settlement, setSettlement] = useState<SettlementRow | null>(null);
  const [evidence, setEvidence] = useState<EvidenceChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ran, setRan] = useState<Ran[]>([]);
  /**
   * The lock the payer's wallet has still to execute.
   *
   * Held in memory rather than refetched, because it is the RESPONSE to
   * settling. Every field in it is already on the settlement row except the one
   * that matters for signing — the contract's own paymentRef — so there is no
   * endpoint that reconstitutes it. Reload the page mid-flow and the escrow can
   * be funded again from the settlement row; see `fundingStep` below.
   */
  const [prepared, setPrepared] = useState<PreparedLock | null>(null);
  const [fundStage, setFundStage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await token();
      const p = await getPayment(t, id);
      setPayment(p);
      // Both are optional context: a DIRECT payment has no escrow, and a
      // payment that never ran a decision has no evidence worth reading yet.
      setSettlement(await getSettlement(t, id).catch(() => null));
      setEvidence(await getEvidence(t, id).catch(() => null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token, id]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  /** Runs one API call and keeps what it sent and what came back. */
  const act = useCallback(
    async (label: string, path: string, opts: { approver?: boolean; body?: unknown } = {}) => {
      setBusy(label);
      setError(null);
      const started = Date.now();
      try {
        let t = await token();
        if (opts.approver) {
          // Settling is approver-scoped: an agent token cannot move money, and
          // that separation is the control, not a formality.
          const mint = await api("/dev/token", {
            method: "POST",
            body: { role: "approver", subject: "securtxn-web" },
          });
          if (!mint.ok) throw new Error(`approver token → ${messageOf(mint.body)}`);
          t = (mint.body as { token: string }).token;
        }
        const call = await api(path, { method: "POST", token: t, body: opts.body ?? {} });
        setRan((r) => [
          {
            label,
            ...(opts.body !== undefined ? { request: opts.body } : {}),
            response: call.body,
            ms: Date.now() - started,
            ok: call.ok,
          },
          ...r,
        ]);
        if (!call.ok) throw new Error(messageOf(call.body));
        // Payer-funded settlement answers with an instruction, not a receipt.
        const maybe = (call.body as { preparedLock?: PreparedLock | null }).preparedLock;
        if (maybe) setPrepared(maybe);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [token, load],
  );

  if (error && !payment) {
    return (
      <>
        <PageHeader title="Payment" back={{ href: "/app/payments", label: "Payments" }} />
        <Alert tone="error" title="Could not load this payment">
          {error}
        </Alert>
      </>
    );
  }

  /**
   * The instruction to execute, whether it came from settling just now or from
   * a settlement row left PENDING_LOCK by an earlier visit.
   */
  const pendingLock =
    prepared ??
    (settlement && settlement.status === "PENDING_LOCK"
      ? preparedFromSettlement(id, settlement)
      : null);

  /** Approve and lock, from the payer's own wallet. */
  const fund = useCallback(async () => {
    const prepared = pendingLock;
    if (!prepared) return;
    setBusy("fund");
    setError(null);
    try {
      const signer = await metamaskSigner(prepared.payerAddress as `0x${string}`);
      const { lockTxHash } = await fundEscrow({
        paymentId: id,
        prepared,
        signer,
        token: await token(),
        report: setFundStage,
      });
      setRan((r) => [{ label: "fund escrow", response: { lockTxHash }, ms: 0, ok: true }, ...r]);
      setPrepared(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFundStage(null);
      setBusy(null);
    }
  }, [pendingLock, id, token, load]);

  if (!payment) {
    return (
      <>
        <PageHeader title="Payment" back={{ href: "/app/payments", label: "Payments" }} />
        <Panel className="h-64 animate-pulse opacity-40">
          <span className="sr-only">Loading</span>
        </Panel>
      </>
    );
  }

  const meta = statusMeta(payment.status);
  const stages = deriveStages(
    payment,
    settlement,
    evidence ? { chainValid: evidence.chainValid, count: evidence.records.length } : null,
  );

  // Exactly one thing is actionable at a time, because the services allow
  // exactly one. Showing four buttons of which three 409 is not a product.
  const next =
    payment.status === "DECISION_PENDING"
      ? {
          label: "Run the identity match",
          hint: "The enclave compares digests. Neither side learns anything about the other beyond match or no match.",
          run: () => void act("run-decision", `/payments/${id}/run-decision`),
        }
      : payment.status === "AWAITING_APPROVAL" && !payment.txHash
        ? {
            label: "Authorise this payment",
            hint:
              "Approver-scoped. This fixes the escrow terms and the secret that releases it — " +
              "it does not move money. You fund it from your own wallet next.",
            run: () => void act("settle", `/payments/${id}/settle`, { approver: true }),
          }
        : // APPROVED means authorised and not yet paid. The platform cannot do
          // this step: the escrow refunds to whoever sends the lock, so it has
          // to be the payer's own wallet.
          payment.status === "APPROVED" && pendingLock
          ? {
              label: fundStage ?? "Fund the escrow from your wallet",
              hint:
                "Two confirmations in MetaMask: one to let the escrow take exactly this amount, " +
                "one to lock it. The money leaves your account and returns there if nobody claims it.",
              run: () => void fund(),
            }
          : null;

  const canPropose = payment.decision === "SAFE_TO_SEND" && payment.status === "DECISION_PENDING";

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="tabular-nums">
              {payment.amount} <span className="text-[16px] text-mist-400">{payment.token}</span>
            </span>
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          </span>
        }
        lead={
          <>
            Invoice <Code>{payment.invoiceRef}</Code> · raised{" "}
            <Relative iso={payment.createdAt} />
            {meta.waitingOn && <> · waiting on {meta.waitingOn}</>}
          </>
        }
        back={{ href: "/app/payments", label: "Payments" }}
        actions={
          <IconButton icon={<RefreshIcon />} label="Refresh" onClick={() => void load()} />
        }
      />

      {error && (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      )}

      {payment.decision && (
        <div className="mb-4">
          <Verdict decision={payment.decision} reason={payment.decisionReasonCode} />
          {payment.decisionReasonCode === "VENDOR_MATCH_FAILED" && (
            <Alert tone="warn" className="mt-2" title="The identity did not match">
              The address you were given is KYC&apos;d to a different legal identity than the one
              you said you were paying.
            </Alert>
          )}
        </div>
      )}

      {/* One action, when there is one. */}
      {next && (
        <Panel className="mb-4 border-signal-500/25 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-mist-50">{next.label}</p>
              <p className="mt-0.5 text-[12px] text-mist-500">{next.hint}</p>
            </div>
            <Button variant="primary" onClick={next.run} busy={busy !== null}>
              {next.label}
            </Button>
          </div>
        </Panel>
      )}

      {canPropose && (
        <Panel className="mb-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium text-mist-50">Send for approval</p>
              <p className="mt-0.5 text-[12px] text-mist-500">
                Writes a proposal. It does not send money — that happens on the approver&apos;s own
                machine.
              </p>
            </div>
            <Button
              variant="primary"
              onClick={() => void act("propose", `/payments/${id}/propose`)}
              busy={busy !== null}
            >
              Send for approval
            </Button>
          </div>
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="space-y-4">
          <Panel className="p-5">
            <h2 className="mb-4 text-[13.5px] font-semibold text-mist-50">Timeline</h2>
            <ol className="relative">
              {stages.map((stage, i) => (
                <li
                  key={stage.id}
                  // Kept on hover rather than deleted: the sentence is why the
                  // step exists, and a timeline of twelve of them printed in
                  // full was prose, not a timeline.
                  title={stage.proves}
                  className="relative flex gap-3 pb-4 last:pb-0"
                >
                  {/* The connector. Stops at the last item so the column does
                      not trail off into nothing. */}
                  {i < stages.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute top-5 bottom-0 left-[8px] w-px bg-white/[0.08]"
                    />
                  )}
                  <span className="relative z-10 mt-0.5 shrink-0 bg-ink-panel">
                    <StepGlyph tone={stage.tone} size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-[10.5px] text-mist-600">{stage.code}</span>
                      <span
                        className={`text-[13px] font-medium ${
                          stage.tone === "idle" ? "text-mist-500" : "text-mist-50"
                        }`}
                      >
                        {stage.title}
                      </span>
                    </div>
                    {stage.detail && (
                      // GREY FOR ARTEFACTS, ACCENT FOR A VERDICT.
                      //
                      // Most of these are what a step produced — an amount, a
                      // transaction hash, a decision code. Worth reading and
                      // copying, not worth the one colour that means "look
                      // here": ten accent lines down a finished timeline is ten
                      // things competing for attention that is already spent.
                      //
                      // Evidence keeps it, because it is the only line that is
                      // a CLAIM rather than a record. "27 records, chain valid"
                      // is the answer to "can any of the above be trusted", and
                      // it is the one thing on this screen worth looking at
                      // twice. A failure keeps its colour for the same reason.
                      <p
                        className={`mt-1 font-mono text-[11px] break-all ${
                          stage.tone === "failed"
                            ? "text-halt-400"
                            : stage.id === "evidence"
                              ? "text-signal-300"
                              : "text-mist-400"
                        }`}
                      >
                        {stage.detail}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          {evidence && (
            <Panel className="p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13.5px] font-semibold text-mist-50">Evidence chain</h2>
                <StatusPill tone={evidence.chainValid ? "ok" : "failed"}>
                  {evidence.chainValid ? "valid" : `broken at ${evidence.brokenAtIndex}`}
                </StatusPill>
              </div>
              <p className="mb-3 text-[11.5px] leading-relaxed text-mist-500">
                Each record hashes the one before it, so removing or editing any of them is
                detectable by anyone, without trusting us.
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {evidence.records.map((record, i) => (
                  <span key={record.id} className="flex items-center gap-1">
                    {i > 0 && <span className="text-mist-600">→</span>}
                    <Code>{record.eventType}</Code>
                  </span>
                ))}
              </div>
            </Panel>
          )}

          {/* Everything this screen actually sent, kept verbatim. */}
          {ran.length > 0 && (
            <Panel className="p-5">
              <h2 className="mb-1 text-[13.5px] font-semibold text-mist-50">Technical</h2>
              <p className="mb-3 text-[11.5px] text-mist-500">
                The real calls this screen made, and exactly what came back.
              </p>
              <ul className="space-y-2">
                {ran.map((entry, i) => (
                  <li key={`${entry.label}-${i}`} className="well p-3">
                    <div className="flex items-center gap-2">
                      <StatusPill tone={entry.ok ? "ok" : "failed"} />
                      <span className="font-mono text-[12px] text-mist-200">{entry.label}</span>
                      <span className="ml-auto font-mono text-[10.5px] text-mist-600 tabular-nums">
                        {entry.ms}ms
                      </span>
                    </div>
                    <JsonDrawer
                      className="mt-2"
                      {...(entry.request !== undefined ? { request: entry.request } : {})}
                      {...(entry.response !== undefined ? { response: entry.response } : {})}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <aside className="space-y-4">
          <Panel className="p-4">
            <h2 className="mb-3 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
              Details
            </h2>
            <Field k="Payment id" v={payment.id} copy />
            <Field k="Invoice" v={payment.invoiceRef} mono copy />
            <Field k="Amount" v={`${payment.amount} ${payment.token}`} />
            <Field k="Network" v={payment.network} />
            <Field k="Settles" v={payment.settlementMode} />
            <Field k="Status" v={payment.status} />
            <Field
              k="Decision"
              v={payment.decision}
              tone={
                payment.decision === "SAFE_TO_SEND"
                  ? "ok"
                  : payment.decision === "DO_NOT_SEND"
                    ? "halt"
                    : payment.decision
                      ? "warn"
                      : undefined
              }
            />
            <Field k="Reason" v={payment.decisionReasonCode} />
            <Field k="Payee wallet" v={payment.vendorWalletId} copy />
            {payment.txHash && <Field k="Transaction" v={payment.txHash} mono copy />}
          </Panel>

          {settlement && (
            <Panel className="p-4">
              <h2 className="mb-3 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
                Escrow
              </h2>
              <Field k="Status" v={settlement.status} />
              <Field k="Contract" v={settlement.escrowAddress} mono copy />
              <Field k="Lock id" v={settlement.lockId} mono copy />
              <Field k="Refunds after" v={settlement.timelock} />
              {settlement.claimTxHash && (
                <Field k="Claim tx" v={settlement.claimTxHash} mono copy />
              )}
              {settlement.refundTxHash && (
                <Field k="Refund tx" v={settlement.refundTxHash} mono copy />
              )}
              {/* <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
                Unclaimed, this returns to you automatically after the timelock. That is the point
                of escrow here — recovery does not need the counterparty to cooperate.
              </p> */}
            </Panel>
          )}

          <Panel className="p-4">
            <h2 className="mb-2 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
              Commitment
            </h2>
            {/* <p className="mb-2 text-[11px] leading-relaxed text-mist-500">
              A hash over what you stated when you raised this. It is what makes the claim
              non-repudiable without storing the claim itself.
            </p> */}
            <Hash value={payment.senderContextCommitment} chars={10} />
          </Panel>
        </aside>
      </div>
    </>
  );
}
