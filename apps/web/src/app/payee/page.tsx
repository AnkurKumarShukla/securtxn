"use client";

// The PAYEE's own page — the one you send to the other party.
//
// Two halves, in the order the flow actually happens:
//
//   1. Onboard. They consent with THEIR OWN DigiLocker account, and the payout
//      key is generated and kept in THEIR browser. That is the whole reason
//      this is a separate page: one DigiLocker identity backs one vendor, so
//      two parties cannot both onboard from one browser session, and a payout
//      key held by the sender is not a payout key the payee controls.
//
//   2. Accept or deny incoming payments. Nothing about them is verified until
//      they accept, which is what stops the identity match being a free
//      lookup oracle.
//
// LEGACY — DO NOT COPY FROM THIS FILE, AND DO NOT RESTYLE IT.
//
// Superseded by `/app/inbox`, `/app/escrow` and `/app/identity`; its logic was
// extracted into `hooks/usePayeeFlow.ts` and this page was left behind intact.
// Every style below is an inline `React.CSSProperties` object over raw hex, and
// it carries its own copies of `Field` and the copy button. It also keeps its
// own five-second poll, which still has the sequential fan-out that the hook no
// longer has — another reason not to read this file for patterns.
//
// It is scheduled for deletion once the escrow claim path is confirmed covered
// by `/app/escrow`. Until then nothing here changes: restyling a file you intend
// to delete is waste, and it tells the next person the file is current.
//
// Spec: docs/payment-flow.md

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IDENTITY_BINDING_TYPES,
  PAYEE_CONSENT_TYPES,
  WALLET_CONTROL_TYPES,
  CONTROL_STATEMENT,
  PAYEE_CONSENT_STATEMENT,
  domainFor,
} from "@cp/shared-types";
import { LegacyBanner } from "../../components/ui/LegacyBanner";
import { api, messageOf, payeeSignal } from "../../lib/flow";
import { pollConsent } from "../../lib/digilocker";
import { claimEscrow } from "../../lib/claim";
import { localSigner } from "../../lib/wallet";
import {
  accountOf,
  clearSession,
  loadSession,
  saveSession,
  type PayeeSession,
} from "../../lib/payeeSession";
import { WorldIdStep } from "../console/WorldIdStep";

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "296");

type Busy = string | null;

type Escrow = {
  paymentRequestId: string;
  status: string;
  amount: string;
  escrowAddress: string;
  timelock: string;
  claimTxHash: string | null;
};

type Incoming = {
  paymentRequestId: string;
  payerLegalName: string;
  payerVerificationTier: string;
  amount: string;
  token: string;
  invoiceRef: string;
  payeeAddress: string;
};

export default function PayeePage() {
  const [session, setSession] = useState<PayeeSession | null>(null);
  const [legalName, setLegalName] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [worldIdForPayment, setWorldIdForPayment] = useState<Record<string, string>>({});
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const tokenRef = useRef<string | null>(null);

  // The key must not be generated during render: this component is still
  // server-rendered, and a different key on each side is a hydration mismatch.
  //
  // The stored vendor is checked HERE rather than when the button is pressed,
  // because the UI disables fields based on it. A vendor removed server-side
  // would otherwise leave the name locked against a record that no longer
  // exists, with no way to type a new one.
  useEffect(() => {
    const stored = loadSession();
    setSession(stored);
    if (!stored.vendorId) return;

    void (async () => {
      try {
        const t = await token();
        const probe = await api(`/vendors/${stored.vendorId}`, { token: t });
        if (probe.status === 404) {
          const fresh = { ...stored, vendorId: null, walletId: null, enrolmentId: null };
          saveSession(fresh);
          setSession(fresh);
          say("the vendor stored here no longer exists — starting fresh (your key is kept)");
          return;
        }
        const name = (probe.body as { displayName?: string }).displayName;
        if (name) setLegalName(name);
      } catch {
        /* offline or starting up — the onboard button probes again anyway */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const say = useCallback(
    (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 60)),
    [],
  );

  const update = useCallback((patch: Partial<PayeeSession>) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      saveSession(next);
      return next;
    });
  }, []);

  const token = useCallback(async (): Promise<string> => {
    if (tokenRef.current) return tokenRef.current;
    const res = await api("/dev/token", {
      method: "POST",
      body: { role: "agent", subject: "payee-page" },
    });
    if (!res.ok) throw new Error(`could not mint a token: ${messageOf(res.body)}`);
    tokenRef.current = (res.body as { token: string }).token;
    return tokenRef.current;
  }, []);

  /** Wraps an action so every failure lands somewhere visible. */
  const act = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
        say(`✓ ${label}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`${label}: ${message}`);
        say(`✗ ${label} — ${message}`);
      } finally {
        setBusy(null);
      }
    },
    [say],
  );

  // --- onboarding ----------------------------------------------------------

  const onboard = useCallback(
    () =>
      act("onboard", async () => {
        if (!session) throw new Error("session not ready");
        const t = await token();
        const account = accountOf(session);

        // 1. the vendor record
        let vendorId = session.vendorId;

        // A stored id can outlive the record it points at — the vendor may have
        // been removed server-side between attempts. Without this check every
        // later call 404s against a ghost, and the page would keep insisting
        // the person is half-onboarded. The KEY is kept, so their payout
        // address stays the same across the restart.
        if (vendorId) {
          const probe = await api(`/vendors/${vendorId}`, { token: t });
          if (probe.status === 404) {
            say(`vendor ${vendorId} no longer exists — starting fresh`);
            vendorId = null;
            update({ vendorId: null, walletId: null, enrolmentId: null });
          }
        }

        if (!vendorId) {
          if (!legalName.trim()) throw new Error("enter your legal entity name first");
          const created = await api("/vendors", {
            method: "POST",
            token: t,
            body: { payeeType: "BUSINESS", legalEntityName: legalName.trim(), country: "IN" },
          });
          if (!created.ok) throw new Error(`create vendor → ${messageOf(created.body)}`);
          vendorId = (created.body as { id: string }).id;
          update({ vendorId });
          say(`vendor ${vendorId}`);
        }

        // 2. DigiLocker, with a real human consent in the middle.
        //
        // "Already done" is a property of the VENDOR, not of the session. An
        // earlier version asked the session, which reports `succeeded` the
        // moment a human consents — so a resumed run skipped
        // `identity/complete`, the call that actually fetches the documents and
        // writes the identity. The wallet then stayed PENDING_VERIFICATION with
        // nothing in the log to say why.
        const vendor = await api(`/vendors/${vendorId}`, { token: t });
        if (!vendor.ok) throw new Error(`read vendor → ${messageOf(vendor.body)}`);
        const verified =
          (vendor.body as { verificationTier?: string }).verificationTier !== "TIER0_UNVERIFIED";

        if (!verified) {
          // A consent already given is reusable: complete it rather than
          // paying for a second session.
          const existing = await api(`/vendors/${vendorId}/identity/status`, { token: t });
          const consented =
            existing.ok && (existing.body as { status?: string }).status === "succeeded";

          if (!consented) {
            const sess = await api(`/vendors/${vendorId}/identity/session`, {
              method: "POST",
              token: t,
              body: { docTypes: ["aadhaar", "pan"] },
            });
            if (!sess.ok) throw new Error(`identity/session → ${messageOf(sess.body)}`);
            const { authorizationUrl } = sess.body as { authorizationUrl: string };
            setConsentUrl(authorizationUrl);
            window.open(authorizationUrl, "_blank", "noopener");
            say("waiting for your DigiLocker consent…");

            // Same loop the console runs — see lib/digilocker.ts. The messages
            // stay this page's own, because they are what the payee reads.
            const outcome = await pollConsent({ vendorId, token: t });
            if (outcome === "failed" || outcome === "expired") {
              throw new Error(`DigiLocker session ${outcome}`);
            }
            if (outcome === "timeout") {
              throw new Error("timed out waiting for DigiLocker consent");
            }
            setConsentUrl(null);
          } else {
            say("consent already given — completing it");
          }

          const done = await api(`/vendors/${vendorId}/identity/complete`, {
            method: "POST",
            token: t,
          });
          if (!done.ok) throw new Error(`identity/complete → ${messageOf(done.body)}`);
          say("DigiLocker verified");
        } else {
          say("identity already verified");
        }

        // 3. the payout wallet, proved with the key in THIS browser
        let walletId = vendorId === session.vendorId ? session.walletId : null;
        if (!walletId) {
          const reg = await api(`/vendors/${vendorId}/wallets`, {
            method: "POST",
            token: t,
            body: { address: account.address, network: "ethereum" },
          });
          if (!reg.ok) throw new Error(`register wallet → ${messageOf(reg.body)}`);
          const { walletId: id, controlProofNonce } = reg.body as {
            walletId: string;
            controlProofNonce: `0x${string}`;
          };
          walletId = id;
          update({ walletId });

          const controlSig = await account.signTypedData({
            domain: domainFor(CHAIN_ID),
            types: WALLET_CONTROL_TYPES,
            primaryType: "WalletControlProof",
            message: {
              vendorId,
              walletAddress: account.address,
              network: "ethereum",
              nonce: controlProofNonce,
              statement: CONTROL_STATEMENT,
            },
          });
          const cp = await api(`/vendors/${vendorId}/wallets/${walletId}/control-proof`, {
            method: "POST",
            token: t,
            body: { signature: controlSig },
          });
          if (!cp.ok) throw new Error(`control-proof → ${messageOf(cp.body)}`);
          say("control proof accepted");
        }

        // 4. bind that key to the DigiLocker subject
        // These used to be `if (ok)` with no else, so a failure skipped the
        // step and the wallet silently stayed unconfirmed — the symptom showed
        // up on the SENDER's side as "no CONFIRMED wallet", with the cause
        // three steps away and invisible. Each one now reports why.
        const prepared = await api(
          `/vendors/${vendorId}/wallets/${walletId}/identity-binding-message`,
          { token: t },
        );
        if (!prepared.ok) throw new Error(`identity-binding-message → ${messageOf(prepared.body)}`);

        const { domain, message } = prepared.body as {
          domain: { name: string; version: string; chainId: number };
          message: Record<string, string>;
        };
        const bindingSig = await account.signTypedData({
          domain,
          types: IDENTITY_BINDING_TYPES,
          primaryType: "IdentityBinding",
          message: message as never,
        });
        const bind = await api(`/vendors/${vendorId}/wallets/${walletId}/identity-binding`, {
          method: "POST",
          token: t,
          body: { signature: bindingSig },
        });
        if (!bind.ok) throw new Error(`identity-binding → ${messageOf(bind.body)}`);
        say("identity binding accepted");

        // 5. confirmed out-of-band, on a contact the registry already knew
        const channels = await api(
          `/vendors/${vendorId}/wallets/${walletId}/callback-channels`,
          { token: t },
        );
        if (!channels.ok) throw new Error(`callback-channels → ${messageOf(channels.body)}`);

        const list = (channels.body as { channels: { value: string; source: string }[] }).channels;
        if (!list[0]) {
          throw new Error(
            "no independent contact on file, so nothing may confirm this wallet. " +
              "Confirmation has to reach a channel the registry or DigiLocker already knew — " +
              "never one supplied with the wallet (D05).",
          );
        }

        const confirm = await api(`/vendors/${vendorId}/wallets/${walletId}/callback-confirm`, {
          method: "POST",
          token: t,
          body: { confirmedBy: "payee-page", channelUsed: list[0].value },
        });
        if (!confirm.ok) throw new Error(`callback-confirm → ${messageOf(confirm.body)}`);
        say(`wallet CONFIRMED via ${list[0].source}`);

        // 6. the token's own compliance list
        const grant = await api(`/vendors/${vendorId}/wallets/${walletId}/grant-kyc`, {
          method: "POST",
          token: t,
          body: {},
        });
        if (!grant.ok) throw new Error(`grant-kyc → ${messageOf(grant.body)}`);
        const { txHash } = grant.body as { txHash?: string };
        say(`on-chain KYC granted${txHash ? ` — ${txHash.slice(0, 18)}…` : ""}`);
      }),
    [act, session, legalName, token, update, say],
  );

  // --- incoming payments ---------------------------------------------------

  const refresh = useCallback(async () => {
    if (!session?.vendorId) return;
    try {
      const t = await token();
      const res = await api(`/vendors/${session.vendorId}/notifications?unreadOnly=true`, {
        token: t,
      });
      if (!res.ok) return;

      const rows = res.body as { kind: string; paymentRequestId: string | null }[];
      const ids = [
        ...new Set(
          rows
            .filter((r) => r.kind === "CONSENT_REQUESTED" && r.paymentRequestId)
            .map((r) => r.paymentRequestId as string),
        ),
      ];

      const prompts: Incoming[] = [];
      for (const id of ids) {
        const p = await api(`/payments/${id}/consent-prompt`, { token: t });
        if (p.ok) prompts.push(p.body as Incoming);
      }
      setIncoming(prompts);

      // Money already locked FOR this payee. It is not in their possession
      // until they claim it, so it needs to be visible and actionable — an
      // escrow nobody claims refunds to the sender.
      const mine = await api(`/vendors/${session.vendorId}/notifications`, { token: t });
      const paymentIds = [
        ...new Set(
          ((mine.ok ? mine.body : []) as { paymentRequestId: string | null }[])
            .map((r) => r.paymentRequestId)
            .filter((v): v is string => Boolean(v)),
        ),
      ];
      const found: Escrow[] = [];
      for (const id of paymentIds) {
        const st = await api(`/payments/${id}/settlement`, { token: t });
        if (st.ok) found.push({ paymentRequestId: id, ...(st.body as object) } as Escrow);
      }
      setEscrows(found);
    } catch {
      /* a failed poll is not worth interrupting the page for */
    }
  }, [session?.vendorId, token]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const claim = useCallback(
    (escrow: Escrow) =>
      act(`claim ${escrow.amount}`, async () => {
        if (!session) throw new Error("session not ready");
        const t = await token();
        const { claimTxHash } = await claimEscrow({
          paymentId: escrow.paymentRequestId,
          // This legacy page has no wallet connection and is not getting one.
          // It always signs with the key generated in this browser, which is
          // what it has always done — see the header note; MetaMask support
          // lives in `/app/*`.
          signer: localSigner(session.privateKey),
          token: t,
          report: say,
        });
        say(`claimed — ${claimTxHash}`);
        await refresh();
      }),
    [act, session, token, say, refresh],
  );

  const decide = useCallback(
    (payment: Incoming, decision: "ACCEPTED" | "DENIED") =>
      act(`${decision === "ACCEPTED" ? "accept" : "deny"} ${payment.invoiceRef}`, async () => {
        if (!session) throw new Error("session not ready");
        const account = accountOf(session);

        if (decision === "DENIED") {
          const res = await api(`/payments/${payment.paymentRequestId}/consent`, {
            method: "POST",
            body: { decision: "DENIED" },
          });
          if (!res.ok) throw new Error(messageOf(res.body));
          await refresh();
          return;
        }

        // Signed by the payout address, over this exact amount and invoice —
        // so a captured signature cannot wave through a different payment.
        const signature = await account.signTypedData({
          domain: domainFor(CHAIN_ID),
          types: PAYEE_CONSENT_TYPES,
          primaryType: "PayeeConsent",
          message: {
            paymentRequestId: payment.paymentRequestId,
            payeeAddress: payment.payeeAddress as `0x${string}`,
            amount: payment.amount,
            token: payment.token,
            invoiceRef: payment.invoiceRef,
            statement: PAYEE_CONSENT_STATEMENT,
          },
        });

        const worldId = worldIdForPayment[payment.paymentRequestId];
        const res = await api(`/payments/${payment.paymentRequestId}/consent`, {
          method: "POST",
          body: {
            decision: "ACCEPTED",
            signature,
            signerAddress: account.address,
            ...(worldId ? { worldIdVerificationId: worldId } : {}),
          },
        });
        if (!res.ok) throw new Error(messageOf(res.body));
        await refresh();
      }),
    [act, session, worldIdForPayment, refresh],
  );

  if (!session) {
    return (
      <main style={S.main}>
        <LegacyBanner page="payee page" instead="/app/inbox" />
        <p style={S.sub}>Preparing your session…</p>
      </main>
    );
  }

  const account = accountOf(session);
  const onboarded = Boolean(session.vendorId && session.walletId);

  return (
    <main style={S.main}>
      <LegacyBanner page="payee page" instead="/app/inbox" />
      <h1 style={S.h1}>You are the payee</h1>
      <p style={S.sub}>
        Onboard once with your own DigiLocker account, then accept or refuse payments sent to
        you. Your payout key is generated here and never leaves this browser.
      </p>

      {error && <div style={S.banner}>{error}</div>}

      <section style={S.card}>
        <h2 style={S.h2}>1 · Onboard</h2>
        <label style={S.label}>
          Your legal entity name
          <input
            style={S.input}
            value={legalName}
            placeholder="e.g. your company's registered name"
            onChange={(e) => setLegalName(e.target.value)}
            disabled={Boolean(session.vendorId)}
          />
        </label>
        <p style={S.hint}>A label only — the match uses your DigiLocker name and PAN.</p>

        <div style={S.row}>
          <Field k="Vendor id" v={session.vendorId} copy />
          <Field k="Payout ADDRESS" v={account.address} mono copy />
          <Field k="Wallet row" v={session.walletId} copy />
        </div>

        <button style={S.primary} onClick={() => void onboard()} disabled={busy !== null}>
          {busy === "onboard" ? "Onboarding…" : onboarded ? "Re-run onboarding" : "Start onboarding"}
        </button>

        {consentUrl && (
          <div style={S.prompt}>
            <span style={S.promptText}>Consent tab did not open?</span>
            <a href={consentUrl} target="_blank" rel="noopener" style={S.link}>
              open DigiLocker
            </a>
          </div>
        )}

        {session.vendorId && (
          <>
            <h3 style={S.h3}>World ID enrolment</h3>
            <p style={S.hint}>
              Do this once. It records the nullifier every later check is compared against — it
              is what proves a later acceptance came from the same human.
            </p>
            <WorldIdStep
              title="Enrol (O7)"
              purpose="ENROLLMENT"
              signal={`enrol:${session.vendorId}`}
              subject={session.vendorId}
              onVerified={(id) => update({ enrolmentId: id })}
            />
            <Field k="Enrolment" v={session.enrolmentId} />
          </>
        )}

        {onboarded && (
          <div style={S.handoff}>
            <strong style={S.handoffTitle}>Send these to the sender</strong>
            <Field k="Vendor id" v={session.vendorId} mono copy />
            <Field k="Payout address" v={account.address} mono copy />
            <button
              style={S.ghost}
              onClick={() =>
                void navigator.clipboard.writeText(
                  `vendorId: ${session.vendorId}\naddress: ${account.address}`,
                )
              }
            >
              copy both
            </button>
          </div>
        )}
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>2 · Payments waiting for you</h2>
        {incoming.length === 0 && (
          <p style={S.hint}>
            Nothing yet. This checks every 5 seconds — the sender has to raise a payment and pass
            their own World ID check before it reaches you.
          </p>
        )}

        {incoming.map((payment) => (
          <div key={payment.paymentRequestId} style={S.payment}>
            <div style={S.paymentHead}>
              <span style={S.amount}>
                {payment.amount} {payment.token}
              </span>
              <span style={S.invoice}>{payment.invoiceRef}</span>
            </div>
            <Field k="From" v={payment.payerLegalName || "(unnamed)"} />
            <Field k="Their verification" v={payment.payerVerificationTier} />
            <Field k="To your address" v={payment.payeeAddress} mono />

            <h3 style={S.h3}>Prove it is still you (P5)</h3>
            <WorldIdStep
              title="Selfie check"
              purpose="REVERIFICATION"
              signal={payeeSignal(payment.paymentRequestId)}
              subject={session.vendorId ?? ""}
              onVerified={(id) =>
                setWorldIdForPayment((m) => ({ ...m, [payment.paymentRequestId]: id }))
              }
            />

            <div style={S.actions}>
              <button
                style={S.primary}
                onClick={() => void decide(payment, "ACCEPTED")}
                disabled={busy !== null}
              >
                Accept and sign
              </button>
              <button
                style={S.ghost}
                onClick={() => void decide(payment, "DENIED")}
                disabled={busy !== null}
              >
                Deny
              </button>
            </div>
            <p style={S.hint}>
              Accepting signs with your payout key over this amount and invoice. Denying needs no
              signature and stops the payment dead — nothing about you is checked.
            </p>
          </div>
        ))}
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>3 · Money locked for you</h2>
        {escrows.length === 0 && (
          <p style={S.hint}>
            Nothing locked. When a sender settles through the escrow, the funds appear here and
            are yours only once you claim them.
          </p>
        )}
        {escrows.map((e) => (
          <div key={e.paymentRequestId} style={S.payment}>
            <div style={S.paymentHead}>
              <span style={S.amount}>{e.amount}</span>
              <span style={S.invoice}>{e.status}</span>
            </div>
            <Field k="Escrow" v={e.escrowAddress} mono copy />
            <Field k="Refunds after" v={e.timelock} />
            {e.claimTxHash && <Field k="Claim tx" v={e.claimTxHash} mono copy />}

            {e.status === "LOCKED" ? (
              <>
                <button
                  style={S.primary}
                  onClick={() => void claim(e)}
                  disabled={busy !== null}
                >
                  {busy?.startsWith("claim") ? "Claiming…" : "Claim the money"}
                </button>
                <p style={S.hint}>
                  Claiming reveals the secret on chain from your own key. That reveal is the
                  receipt — nobody can produce it for you, and if you never claim, the money
                  returns to the sender after the timelock.
                </p>
              </>
            ) : (
              <p style={S.hint}>
                {e.status === "CLAIMED" ? "Claimed — the money is yours." : `Escrow is ${e.status}.`}
              </p>
            )}
          </div>
        ))}
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>Activity</h2>
        <pre style={S.pre}>{log.join("\n") || "nothing yet"}</pre>
        <button
          style={S.ghost}
          onClick={() => {
            clearSession();
            window.location.reload();
          }}
        >
          Log Out
        </button>
        <p style={S.hint}>
          Resetting mints a new payout key. The vendor you already onboarded stays on the server
          but you will no longer be able to sign for it.
        </p>
      </section>
    </main>
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

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 760, margin: "0 auto", padding: "32px 20px 80px", color: "#e4e4e7" },
  h1: { fontSize: 24, fontWeight: 600, margin: 0 },
  h2: { fontSize: 13, textTransform: "uppercase", letterSpacing: "0.07em", color: "#71717a", margin: "0 0 14px" },
  h3: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#71717a", margin: "18px 0 8px" },
  sub: { color: "#a1a1aa", fontSize: 14, lineHeight: 1.6, margin: "8px 0 22px" },
  banner: { background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, lineHeight: 1.5 },
  card: { background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 18, marginBottom: 16 },
  row: { margin: "12px 0" },
  label: { display: "block", fontSize: 12, color: "#a1a1aa", marginBottom: 10 },
  input: { display: "block", width: "100%", marginTop: 5, background: "#09090b", border: "1px solid #3f3f46", borderRadius: 6, color: "#e4e4e7", padding: "8px 10px", fontSize: 13 },
  primary: { background: "#2563eb", color: "white", border: 0, borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" },
  ghost: { background: "transparent", color: "#a1a1aa", border: "1px solid #3f3f46", borderRadius: 8, padding: "9px 16px", fontSize: 13, cursor: "pointer" },
  actions: { display: "flex", gap: 8, marginTop: 12 },
  field: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #27272a", fontSize: 12.5 },
  copyBtn: { background: "transparent", border: 0, color: "#71717a", cursor: "pointer", fontSize: 13, padding: 0, flexShrink: 0 },
  fieldK: { color: "#71717a", flexShrink: 0 },
  fieldV: { color: "#e4e4e7", textAlign: "right", wordBreak: "break-all", minWidth: 0 },
  hint: { fontSize: 12, color: "#a1a1aa", lineHeight: 1.55, margin: "10px 0 0" },
  prompt: { display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 12 },
  promptText: { color: "#a1a1aa" },
  link: { color: "#60a5fa" },
  handoff: { marginTop: 18, padding: 12, border: "1px dashed #3f3f46", borderRadius: 8 },
  handoffTitle: { display: "block", fontSize: 12.5, marginBottom: 8 },
  payment: { border: "1px solid #27272a", borderRadius: 8, padding: 14, marginBottom: 12, background: "#09090b" },
  paymentHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 },
  amount: { fontSize: 20, fontWeight: 600 },
  invoice: { fontSize: 12, color: "#71717a", fontFamily: MONO },
  pre: { fontSize: 11.5, fontFamily: MONO, color: "#d4d4d8", margin: "0 0 12px", whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" },
};
