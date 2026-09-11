"use client";

// One World ID check, bound to one thing.
//
// The important difference from /world-id-test: that page proves the widget
// opens and posts the proof straight to World's verifier. This one posts to OUR
// API, which stores the nullifier and — for a REVERIFICATION — refuses a proof
// from a different human than the one enrolled. That storage IS the control;
// verifying and forgetting proves nothing about continuity.
//
// `signal` is what makes a proof non-transferable. For P2 and P5 it is the
// payment id, so a selfie taken for one payment cannot be replayed against
// another.

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

type Props = {
  title: string;
  purpose: "ENROLLMENT" | "REVERIFICATION";
  signal: string;
  subject: string;
  onVerified: (verificationId: string) => void;
};

export function WorldIdStep({ title, purpose, signal, subject, onVerified }: Props) {
  const [stage, setStage] = useState<"idle" | "preparing" | "open" | "verifying" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);

  const ready = Boolean(WORLD_APP_ID && WORLD_RP_ID && signal && subject);

  async function start() {
    setError(null);
    setStage("preparing");
    try {
      // The widget needs a valid rp_context up front, and only the server holds
      // the signing key.
      const res = await fetch("/api/world-id/rp-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      setStage("error");
      throw new Error(message);
    }

    const id = (call.body as { verificationId?: string; id?: string }).verificationId
      ?? (call.body as { id?: string }).id
      ?? "";
    onVerified(id);
    setStage("done");
  }

  return (
    <div style={S.box}>
      <div style={S.head}>
        <span style={S.title}>{title}</span>
        <span style={{ ...S.badge, background: stage === "done" ? "#22c55e" : "#3f3f46", color: stage === "done" ? "#09090b" : "#a1a1aa" }}>
          {stage}
        </span>
      </div>
      <div style={S.meta}>
        signal: <code style={S.code}>{signal || "— run the earlier step first"}</code>
      </div>
      <button style={S.btn} onClick={start} disabled={!ready || stage === "preparing"}>
        {stage === "done" ? "Verify again" : "Open World ID"}
      </button>
      {!ready && (
        <div style={S.hint}>
          {WORLD_APP_ID && WORLD_RP_ID
            ? "Waiting on the earlier steps for a signal and subject."
            : "NEXT_PUBLIC_WORLD_APP_ID / NEXT_PUBLIC_WORLD_RP_ID are not set."}
        </div>
      )}
      {error && <div style={S.err}>{error}</div>}

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
            setError(JSON.stringify(e));
            setStage("error");
          }}
        />
      )}
    </div>
  );
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const S: Record<string, React.CSSProperties> = {
  box: { border: "1px solid #27272a", borderRadius: 8, padding: 10, marginBottom: 8, background: "#09090b" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  title: { fontSize: 12.5, fontWeight: 500 },
  badge: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4 },
  meta: { fontSize: 11, color: "#71717a", margin: "6px 0 8px", wordBreak: "break-all" },
  code: { fontFamily: MONO, color: "#a1a1aa" },
  btn: { width: "100%", background: "#27272a", color: "#e4e4e7", border: 0, borderRadius: 6, padding: "7px 10px", fontSize: 12.5, cursor: "pointer" },
  hint: { fontSize: 11, color: "#71717a", marginTop: 6, lineHeight: 1.45 },
  err: { fontSize: 11, color: "#fca5a5", marginTop: 6, fontFamily: MONO, lineHeight: 1.45, wordBreak: "break-word" },
};
