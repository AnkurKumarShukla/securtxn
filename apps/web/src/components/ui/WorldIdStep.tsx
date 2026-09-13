"use client";

// One World ID check, bound to one thing.
//
// MOVED from app/console/WorldIdStep.tsx. It was imported across a route
// boundary by the payee page (`../console/WorldIdStep`), which meant the payee
// screen depended on the sender screen's folder for a component neither owns.
// The old path re-exports this, so both pages keep working unchanged.
//
// The important difference from /world-id-test: that page proves the widget
// opens and posts the proof straight to World's verifier. This one posts to OUR
// API, which stores the nullifier and — for a REVERIFICATION — refuses a proof
// from a different human than the one enrolled. That storage IS the control;
// verifying and forgetting proves nothing about continuity.
//
// `signal` is what makes a proof non-transferable. For P2 and P5 it is the
// payment id, so a selfie taken for one payment cannot be replayed against
// another. It is shown on the card for exactly that reason.
//
// NOTE ON COPY (README §4.6): Selfie Check is medium assurance. Nothing here
// may say "identity verified" — it says a live human confirmed this action.

import { useState } from "react";
import {
  IDKitRequestWidget,
  proofOfHuman,
  selfieCheckLegacy,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import {
  WORLD_ACTION,
  WORLD_APP_ID,
  WORLD_ENVIRONMENT,
  WORLD_PRESET,
  WORLD_RP_ID,
} from "../../lib/worldid";
import { api, messageOf } from "../../lib/flow";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { JsonDrawer } from "./JsonDrawer";
import { Tooltip } from "./Tooltip";

type Stage = "idle" | "preparing" | "open" | "verifying" | "done" | "error";

type Props = {
  title: string;
  purpose: "ENROLLMENT" | "REVERIFICATION";
  signal: string;
  subject: string;
  onVerified: (verificationId: string) => void;
};

/** The four things that have to happen, in order. `error` is not a stage — it is a stop. */
const TRACK: { key: Stage; label: string }[] = [
  { key: "preparing", label: "sign request" },
  { key: "open", label: "open World" },
  { key: "verifying", label: "check proof" },
  { key: "done", label: "recorded" },
];

const ORDER: Record<Stage, number> = {
  idle: -1,
  preparing: 0,
  open: 1,
  verifying: 2,
  done: 3,
  error: -1,
};

export function WorldIdStep({ title, purpose, signal, subject, onVerified }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<unknown>(undefined);
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);

  const ready = Boolean(WORLD_APP_ID && WORLD_RP_ID && signal && subject);
  const configured = Boolean(WORLD_APP_ID && WORLD_RP_ID);

  async function start() {
    setError(null);
    setErrorDetail(undefined);
    setStage("preparing");
    try {
      // The widget needs a valid rp_context up front, and only the server holds
      // the signing key.
      const res = await fetch("/api/world-id/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json", "ngrok-skip-browser-warning": "1" },
        body: JSON.stringify({ action: WORLD_ACTION }),
      });
      const sig = await res.json();
      if (!res.ok) throw new Error(sig.error ?? `rp-signature returned ${res.status}`);

      setRpContext({
        rp_id: WORLD_RP_ID,
        nonce: sig.nonce,
        created_at: sig.created_at,
        expires_at: sig.expires_at,
        signature: sig.sig,
      } as RpContext);
      setStage("open");
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  // Runs before onSuccess; throwing surfaces inside the widget.
  async function handleVerify(proof: IDKitResult) {
    setStage("verifying");
    const path = purpose === "ENROLLMENT" ? "/world-id/enroll" : "/world-id/verify";

    // A fresh agent token per check: this component has no access to the run's
    // token, and minting one is a single call in a dev environment.
    const tokenCall = await api("/dev/token", {
      method: "POST",
      body: { role: "agent", subject: "flow-console" },
    });
    if (!tokenCall.ok) throw new Error(`could not mint a token: ${messageOf(tokenCall.body)}`);
    const token = (tokenCall.body as { token: string }).token;

    const call = await api(path, { method: "POST", token, body: { proof, signal, subject } });
    if (!call.ok) {
      const message = messageOf(call.body);
      setError(`${path} → ${call.status}: ${message}`);
      setErrorDetail(call.body);
      setStage("error");
      throw new Error(message);
    }

    const id =
      (call.body as { verificationId?: string; id?: string }).verificationId ??
      (call.body as { id?: string }).id ??
      "";
    onVerified(id);
    setStage("done");
  }

  const done = stage === "done";
  const failed = stage === "error";
  const active = ORDER[stage];

  return (
    <div
      className={`well p-3 transition-colors duration-[--dur-base] ${
        done ? "border-verified-400/30" : failed ? "border-halt-400/30" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[12.5px] font-medium text-mist-100">{title}</span>
        {done ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tracking-[0.08em] text-verified-400 uppercase">
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3.5 8.5 6.5 11.5 12.5 5" />
            </svg>
            confirmed
          </span>
        ) : (
          <span
            className={`shrink-0 font-mono text-[10px] tracking-[0.08em] uppercase ${
              failed ? "text-halt-400" : "text-mist-600"
            }`}
          >
            {stage}
          </span>
        )}
      </div>

      {/* The four-stage track. Replaces a badge that just said "preparing" with
          no indication of how many more there were. */}
      <div className="mt-2.5 flex items-center gap-1">
        {TRACK.map((s, i) => {
          const reached = active >= i;
          return (
            <Tooltip key={s.key} content={s.label} side="bottom" className="flex-1">
              <span
                className={`block h-1 w-full rounded-full transition-colors duration-[--dur-base] ${
                  failed && i === active + 1
                    ? "bg-halt-400"
                    : reached
                      ? done
                        ? "bg-verified-400"
                        : "bg-signal-500"
                      : "bg-white/[0.08]"
                }`}
              />
            </Tooltip>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-baseline gap-1.5 text-[11px]">
        <Tooltip
          content="What this proof is bound to. A check taken for one payment cannot be replayed against another."
          side="bottom"
        >
          <span className="cursor-help text-mist-500 underline decoration-dotted decoration-mist-600/60 underline-offset-4">
            signal
          </span>
        </Tooltip>
        <code className="min-w-0 truncate font-mono text-mist-400">
          {signal || "— run the earlier step first"}
        </code>
      </div>

      <Button
        variant={done ? "quiet" : "ghost"}
        size="sm"
        className="mt-2.5 w-full"
        onClick={start}
        disabled={!ready}
        busy={stage === "preparing"}
      >
        {done ? "Verify again" : "Open World ID"}
      </Button>

      {!ready && (
        <p className="mt-2 text-[11px] leading-relaxed text-mist-600">
          {configured
            ? "Waiting on the earlier steps for a signal and subject."
            : "NEXT_PUBLIC_WORLD_APP_ID / NEXT_PUBLIC_WORLD_RP_ID are not set."}
        </p>
      )}

      {error && (
        <div className="mt-2 space-y-2">
          <Alert tone="error">{error}</Alert>
          {/* The old version did `setError(JSON.stringify(e))` and put raw IDKit
              JSON in front of the user. The readable line is above; the object
              is still here for whoever needs it. */}
          {errorDetail !== undefined && <JsonDrawer response={errorDetail} />}
        </div>
      )}

      {rpContext && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={WORLD_APP_ID}
          action={WORLD_ACTION}
          rp_context={rpContext}
          environment={WORLD_ENVIRONMENT}
          // Selfie Check is backed by a World ID 3.0 proof, so legacy proofs
          // must be accepted or the request cannot be satisfied.
          allow_legacy_proofs
          // The signal lives INSIDE the preset in IDKit 4, not on the widget.
          // It is what makes a proof non-transferable: World hashes it into
          // signal_hash, and the API refuses a proof whose signal_hash does not
          // match the payment (or onboarding session) it was supposed to be for.
          // Passing no signal here would produce a proof that any payment
          // could consume.
          preset={
            WORLD_PRESET === "selfieCheckLegacy"
              ? selfieCheckLegacy({ signal })
              : proofOfHuman({ signal })
          }
          handleVerify={handleVerify}
          // handleVerify already recorded the outcome; onSuccess only closes
          // the widget. Required by the type either way.
          onSuccess={() => setOpen(false)}
          onError={(e) => {
            setError("World ID could not complete this check.");
            setErrorDetail(e);
            setStage("error");
          }}
        />
      )}
    </div>
  );
}
