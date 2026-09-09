"use client";

// Standalone World ID / Selfie Check test surface (B4).
//
// Deliberately NOT wired into the payment flow. Its only job is to prove, to a
// reviewer with the sandbox World ID app, that this app requests Selfie Check
// and that the camera flow opens rather than an Orb screen. The active preset
// and environment are printed on the page so a reviewer can confirm what was
// requested without reading the source.
//
// Wiring this into the approval step comes after the feature flag is confirmed.

import { useState } from "react";
import { IDKitRequestWidget, proofOfHuman, selfieCheckLegacy, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import {
  WORLD_ACTION,
  WORLD_APP_ID,
  WORLD_ENVIRONMENT,
  WORLD_PRESET,
  WORLD_RP_ID,
} from "../../lib/worldid";

type Stage = "idle" | "signing" | "ready" | "verifying" | "done" | "error";

export default function WorldIdTestPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  // The signature is fetched before the widget opens: the widget needs a valid
  // rp_context up front, and the signing key only exists on the server.
  async function start() {
    setError(null);
    setResult(null);
    setStage("signing");
    try {
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
      setStage("ready");
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  // handleVerify runs before onSuccess; throwing here surfaces in the widget.
  async function handleVerify(proof: IDKitResult) {
    setStage("verifying");
    const res = await fetch("/api/world-id/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof),
    });
    const body = await res.json();
    setResult({ idkit: proof, server: body });
    if (!res.ok) throw new Error(`verification failed: ${JSON.stringify(body)}`);
    setStage("done");
  }

  const configured = Boolean(WORLD_APP_ID && WORLD_RP_ID);

  return (
    <main style={S.main}>
      <h1 style={S.h1}>World ID — Selfie Check test</h1>
      <p style={S.sub}>
        Standalone check that this app requests Selfie Check. Not part of the payment flow.
      </p>

      <dl style={S.grid}>
        <Row k="Preset requested" v={WORLD_PRESET} highlight />
        <Row k="Environment" v={WORLD_ENVIRONMENT} highlight />
        <Row k="Action" v={WORLD_ACTION} />
        <Row k="App ID" v={WORLD_APP_ID ?? "(unset)"} />
        <Row k="RP ID" v={WORLD_RP_ID || "(unset)"} />
      </dl>

      <p style={S.note}>
        Scan with the <strong>sandbox</strong> World ID app (TestFlight / Play private track).
        A camera selfie means Selfie Check is enabled. An Orb screen means the request fell
        back — the feature flag is not on for this app.
      </p>

      {!configured && (
        <p style={S.err}>
          NEXT_PUBLIC_WORLD_APP_ID / NEXT_PUBLIC_WORLD_RP_ID are not set — the widget cannot open.
        </p>
      )}

      <button style={S.btn} onClick={start} disabled={!configured || stage === "signing"}>
        {stage === "signing" ? "Preparing…" : "Verify with World ID"}
      </button>

      <p style={S.stage}>status: {stage}</p>
      {error && <pre style={S.err}>{error}</pre>}

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
          preset={
            WORLD_PRESET === "selfieCheckLegacy"
              ? selfieCheckLegacy()
              : proofOfHuman()
          }
          handleVerify={handleVerify}
          onSuccess={() => setStage("done")}
          onError={(e) => {
            setError(JSON.stringify(e, null, 2));
            setStage("error");
          }}
        />
      )}

      {result != null && (
        <>
          <h2 style={S.h2}>Result</h2>
          <p style={S.note}>
            Selfie Check returns <code>responses[].identifier: &quot;selfie&quot;</code>.
          </p>
          <pre style={S.pre}>{JSON.stringify(result, null, 2)}</pre>
        </>
      )}
    </main>
  );
}

function Row({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <>
      <dt style={S.dt}>{k}</dt>
      <dd style={{ ...S.dd, ...(highlight ? S.strong : {}) }}>{v}</dd>
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 640, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", lineHeight: 1.5 },
  h1: { fontSize: 22, marginBottom: 4 },
  h2: { fontSize: 17, marginTop: 28 },
  sub: { color: "#666", marginTop: 0 },
  grid: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: "20px 0", fontSize: 14 },
  dt: { color: "#666" },
  dd: { margin: 0, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" },
  strong: { fontWeight: 700, color: "#0b7" },
  note: { fontSize: 13, color: "#555", background: "#f6f6f6", padding: 12, borderRadius: 8 },
  btn: { padding: "12px 20px", fontSize: 16, borderRadius: 8, border: 0, background: "#111", color: "#fff", cursor: "pointer" },
  stage: { fontSize: 13, color: "#666" },
  err: { color: "#b00", fontSize: 13, whiteSpace: "pre-wrap", background: "#fff2f2", padding: 12, borderRadius: 8 },
  pre: { fontSize: 12, background: "#f6f6f6", padding: 12, borderRadius: 8, overflowX: "auto" },
};
