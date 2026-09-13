"use client";

// The account's state: onboarding it, and running the side that gets paid.
//
// ONE ACCOUNT, BOTH DIRECTIONS. This used to own a payee session of its own —
// a separate vendor, wallet and key from the paying organisation. It does not
// any more. The session lives in `lib/account.ts` and is passed in, because the
// same record is what pays and what is paid: one DigiLocker verification, one
// World ID enrolment, one wallet, one identity binding, one KYC grant. The
// database always insisted on that (a DigiLocker id backs exactly one vendor);
// only the UI pretended there were two people here.
//
// So `onboard()` is now THE onboarding, run once, and everything below it —
// the poll, the consent, the claim — is the receiving half of the same
// account's life.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PAYEE_CONSENT_TYPES,
  PAYEE_CONSENT_STATEMENT,
  domainFor,
  type VendorByAddress,
} from "@cp/shared-types";
import { api, messageOf } from "../lib/flow";
import { pollConsent } from "../lib/digilocker";
import { claimEscrow } from "../lib/claim";
import { onboardWallet } from "../lib/walletOnboarding";
import { clearAccount, type Account } from "../lib/account";
import {
  connectWallet,
  hasInjectedWallet,
  metamaskSigner,
  silentAccount,
  watchWallet,
  WalletError,
  type PayeeSigner,
} from "../lib/wallet";
import type { StepState } from "../lib/flow";

export type Escrow = {
  paymentRequestId: string;
  status: string;
  amount: string;
  escrowAddress: string;
  timelock: string;
  claimTxHash: string | null;
};

export type Incoming = {
  paymentRequestId: string;
  payerLegalName: string;
  payerVerificationTier: string;
  amount: string;
  token: string;
  invoiceRef: string;
  payeeAddress: string;
  /**
   * Whether a World ID check is required before this one can be accepted.
   *
   * Comes from the server, per payment. Accepting without it is REFUSED when
   * true, so a card that guessed and said "optional" offered a button that
   * could only fail.
   */
  challengeRequired: boolean;
};

/** The seven things onboarding does, named so a person can watch them happen. */
export type StageId =
  | "vendor"
  | "identity"
  | "wallet"
  | "binding"
  | "callback"
  | "kyc"
  | "enrol";

export const STAGES: { id: StageId; title: string; proves: string }[] = [
  { id: "vendor", title: "Vendor record", proves: "you exist as a record the sender can name" },
  { id: "identity", title: "DigiLocker consent", proves: "who you legally are — pulled from the issuing authority, never typed" },
  { id: "wallet", title: "Payout wallet", proves: "you hold the key to the address, signed as EIP-712" },
  { id: "binding", title: "Identity binding", proves: "that address belongs to that DigiLocker subject" },
  { id: "callback", title: "Independent confirmation", proves: "a channel the registry already knew confirmed it — never one you supplied" },
  { id: "kyc", title: "On-chain KYC", proves: "the token itself will now accept your address" },
  // SEVENTH, AND IT USED TO BE INVISIBLE. Enrolment was rendered as a widget in
  // a side panel, so a required action read as optional furniture — the list
  // said six things and there were seven. It is a step like the others and it
  // belongs in the sequence.
  //
  // It also cannot be automated, which is the other half of why it was easy to
  // miss: the six above run when you press a button, and this one waits for a
  // person. That is a reason to show it in place, not to hide it.
  {
    id: "enrol",
    title: "Confirm a live human",
    proves:
      "records the nullifier a later check is compared against — it is what can prove a stolen key was used by somebody other than you",
  },
];

/**
 * Poll cadence.
 *
 * Five seconds is right for a tab someone is watching a payment arrive in. It
 * is wasteful for a tab that has been in the background since lunch, and it is
 * actively harmful against an API that is already failing — so both of those
 * back off. Nothing here changes how quickly a WATCHED tab updates.
 */
const POLL_ACTIVE_MS = 5_000;
const POLL_HIDDEN_MS = 15_000;
const POLL_BACKOFF_MS = 30_000;
const POLL_FAILURES_BEFORE_BACKOFF = 3;

/** Most recent notifications expanded per cycle, and how many at once. */
const POLL_FANOUT_CAP = 20;
const POLL_CONCURRENCY = 6;

/**
 * `items.map(work)` with at most `limit` requests in flight.
 *
 * Settled rather than thrown, because these are independent lookups: one
 * payment whose settlement is unreadable must not take the other nineteen off
 * the screen. Results stay in input order.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      try {
        out[i] = { status: "fulfilled", value: await work(item) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

export type StageRecord = { state: StepState; detail?: string | undefined };

export type PayeeFlow = ReturnType<typeof usePayeeFlow>;

export function usePayeeFlow(
  chainId: number,
  /** The one account, owned by AppProvider so both halves of the UI see it. */
  session: Account | null,
  update: (patch: Partial<Account>) => void,
) {
  const [legalName, setLegalName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [consentDeadline, setConsentDeadline] = useState<number | null>(null);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [worldIdForPayment, setWorldIdForPayment] = useState<Record<string, string>>({});
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [stages, setStages] = useState<Record<string, StageRecord>>({});
  const [claimStage, setClaimStage] = useState<Record<string, string>>({});
  // When the poll last completed, and whether it failed. The loop swallows
  // every error, so without this a dead API looks exactly like an empty inbox.
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const tokenRef = useRef<string | null>(null);

  /**
   * The session, readable without being a dependency.
   *
   * `resolveSigner` is called from inside long-running actions. If it closed
   * over the `session` STATE it would need to be rebuilt on every change to it,
   * and every callback depending on it with it — including the ones the poll
   * effect holds, which would tear the poll down and restart it on each tick.
   */
  const sessionRef = useRef<Account | null>(null);
  sessionRef.current = session;

  /**
   * Whether a wallet extension is present.
   *
   * State set from an effect, never read during render. `window.ethereum` does
   * not exist on the server, so calling the detector while rendering gives
   * `false` there and `true` in the browser — React then finds the two trees
   * disagree and throws the whole thing away. It also cannot be read at module
   * load: extensions inject asynchronously and may not have run yet.
   */
  const [walletAvailable, setWalletAvailable] = useState(false);
  useEffect(() => setWalletAvailable(hasInjectedWallet()), []);

  const say = useCallback(
    (line: string) =>
      setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 60)),
    [],
  );

  const stage = useCallback((id: StageId, patch: StageRecord) => {
    setStages((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  }, []);

  // Ref-backed and dependency-free ON PURPOSE. `refresh` depends on this, and
  // the poll effect depends on `refresh` — so an unstable identity here tears
  // down and recreates the five-second interval on every render.
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

  /**
   * Rebuilds the checklist from what the SERVER says, on every load.
   *
   * WHY IT HAS TO. The stage list was React state and nothing else, so a
   * finished account came back from a refresh showing six empty rows and one
   * obvious button. Pressing it re-ran an onboarding that was already done, and
   * the first gate to notice was the callback: "wallet already confirmed". The
   * work was never lost — only the page's memory of it was.
   *
   * Derived rather than cached. A copy of "which steps are done" kept next to
   * the account would be a second source of truth that drifts the moment
   * anything changes server-side: a revoked wallet, an expired verification, a
   * vendor deleted underneath us. Everything below is read back from the record
   * that actually gates the next action.
   *
   * A CONFIRMED wallet is what lets three rows be ticked at once. The API only
   * sets that status when the control proof, the identity binding AND the
   * out-of-band callback have all passed, so the status IS the conjunction of
   * the three — there is nothing weaker to infer from it.
   */
  useEffect(() => {
    const vendorId = session?.vendorId;
    if (!vendorId) return;

    void (async () => {
      try {
        const t = await token();

        const probe = await api(`/vendors/${vendorId}`, { token: t });
        if (probe.status === 404) {
          // The wallet is kept: the account is the connected address, and that
          // does not stop being yours because a row was deleted.
          update({ vendorId: null, walletId: null, enrolmentId: null, identityVerified: false });
          say("the account stored here no longer exists on the server — starting fresh");
          return;
        }
        if (!probe.ok) return;

        const vendor = probe.body as {
          displayName?: string;
          verificationTier?: string;
          aadhaarKycTtl?: string | null;
        };
        if (vendor.displayName) setLegalName(vendor.displayName);
        stage("vendor", { state: "ok", detail: vendorId });

        // Expiry is part of the answer. A restored screen that ticked a lapsed
        // verification would hide a re-verification the rules require (D06).
        const ttl = vendor.aadhaarKycTtl ? new Date(vendor.aadhaarKycTtl) : null;
        const expired = ttl !== null && ttl.getTime() <= Date.now();
        const verified = vendor.verificationTier !== "TIER0_UNVERIFIED" && !expired;
        if (verified) {
          stage("identity", { state: "ok", detail: vendor.verificationTier ?? "verified" });
        } else if (expired) {
          stage("identity", { state: "failed", detail: "verification has expired — run it again" });
        }
        if (session?.identityVerified !== verified) update({ identityVerified: verified });

        const wallets = await api(`/vendors/${vendorId}/wallets`, { token: t });
        if (!wallets.ok) return;
        const rows = wallets.body as {
          id: string;
          address: string;
          status: string;
          supersededById: string | null;
        }[];
        // The current one: not superseded by a later version, and not revoked.
        const current =
          rows.find((w) => !w.supersededById && w.status !== "REVOKED") ?? rows.at(-1) ?? null;
        if (!current) return;

        if (current.id !== session?.walletId) update({ walletId: current.id });
        stage("wallet", { state: "ok", detail: "registered and proved" });

        if (current.status === "CONFIRMED") {
          stage("binding", { state: "ok", detail: "address bound to your DigiLocker subject" });
          stage("callback", { state: "ok", detail: "confirmed out of band" });
        }

        // The on-chain grant stamps the credential, so the credential is the
        // only place that can say whether the token will actually accept this
        // address — the wallet being CONFIRMED is the platform's opinion, not
        // the token's.
        const cred = await api(`/vendors/${vendorId}/wallets/${current.id}/credential`, {
          token: t,
        });
        if (cred.ok) {
          const { grantedTxHash, usable } = cred.body as {
            grantedTxHash: string | null;
            usable: boolean;
          };
          if (grantedTxHash) {
            stage("kyc", { state: "ok", detail: grantedTxHash });
          } else if (!usable) {
            stage("kyc", { state: "failed", detail: "credential expired or revoked" });
          }
        }
      } catch {
        /* offline or starting up — nothing is ticked, which is the safe default */
      }
    })();
    // Keyed on the ids alone: re-running on every account change would re-probe
    // after each patch this effect itself makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.vendorId, session?.walletId]);

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
        // Whichever stage was mid-flight is the one that broke.
        setStages((s) => {
          const open = Object.entries(s).find(([, v]) => v.state === "running");
          if (!open) return s;
          return { ...s, [open[0]]: { state: "failed", detail: message } };
        });
        throw e;
      } finally {
        setBusy(null);
      }
    },
    [say],
  );

  // --- the wallet ----------------------------------------------------------

  /**
   * The signer for whatever this session is using.
   *
   * Resolved per action rather than held in state, because in MetaMask mode the
   * answer can change between one signature and the next: the person can lock
   * the extension, switch account, or switch network, and the page finds out
   * only when it next asks. Asking every time turns all three into a clear
   * error at the moment of signing instead of a signature from the wrong
   * account that verifies as somebody else.
   */
  const resolveSigner = useCallback(async (): Promise<PayeeSigner> => {
    const current = sessionRef.current;
    if (!current) throw new Error("session not ready");
    if (!current.address) {
      throw new WalletError("Connect your wallet first — there is no payout address yet.");
    }
    return metamaskSigner(current.address);
  }, []);

  /** Connect MetaMask and adopt its account as the payout address. */
  const connect = useCallback(
    () =>
      act("connect wallet", async () => {
        const current = sessionRef.current;
        if (!current) throw new Error("session not ready");
        // Changing the payout address after a wallet is registered would leave
        // the vendor confirmed for an address nobody in this browser can sign
        // for — the same orphaning a cleared localStorage used to cause.
        if (current.walletId) {
          throw new Error(
            "This onboarding already has a confirmed payout wallet. Reset the session to use a different account.",
          );
        }
        const address = await connectWallet();
        update({ address });
        say(`wallet connected — ${address}`);

        // THE POINT OF CONNECTING, beyond not holding the key. Everything a
        // returning payee needs is already on the server; what a cleared
        // browser lost was only the pointer to it. The wallet is a better
        // pointer, because it is the same one on every device — so the first
        // thing we do with an address is ask whether it already has a record.
        const found = await api(`/vendors/by-address/${address}`, { token: await token() });
        if (found.status === 404) {
          say("no existing record for this address — this will be a new onboarding");
          return;
        }
        if (!found.ok) {
          // Recovery failing is not connection failing. The wallet is attached
          // and a fresh onboarding still works, so this is said and not thrown.
          say(`could not check for an existing record — ${messageOf(found.body)}`);
          return;
        }

        const rec = found.body as VendorByAddress;
        update({
          vendorId: rec.vendorId,
          walletId: rec.walletId,
          enrolmentId: rec.enrolmentId,
          displayName: rec.displayName,
          identityVerified: rec.identityVerified,
        });
        setLegalName(rec.displayName);

        // Reflect what is already true, so the stage list does not read as
        // "nothing has happened" for someone whose onboarding is finished.
        stage("vendor", { state: "ok", detail: "recovered from your wallet" });
        if (rec.identityVerified) {
          stage("identity", { state: "ok", detail: "already verified — nothing to redo" });
        }
        if (rec.walletStatus === "CONFIRMED") {
          stage("wallet", { state: "ok", detail: "control proof already accepted" });
        }

        say(
          rec.walletStatus === "CONFIRMED"
            ? `welcome back — ${rec.displayName}, verified to ${rec.verificationTier}`
            : `found a part-finished onboarding for ${rec.displayName} — continue where you left off`,
        );
        // Stated rather than assumed: verification expires, and a restored
        // session that quietly claimed otherwise would skip a re-verification
        // the rules require.
        if (rec.aadhaarKycTtl) {
          say(`your DigiLocker verification is good until ${new Date(rec.aadhaarKycTtl).toLocaleDateString()}`);
        }
      }).catch(() => {
        /* act() already recorded it */
      }),
    [act, update, say, token, stage],
  );


  // Reflect what the extension is actually doing. Switching account in MetaMask
  // while half-onboarded is a state the person chose, and they need to see that
  // the page noticed rather than discovering it at the next signature.
  useEffect(() => {
    if (!session?.address) return;
    return watchWallet({
      onAccountsChanged: (accounts) => {
        const next = accounts[0];
        if (!next) {
          say("wallet disconnected");
          return;
        }
        if (next.toLowerCase() !== (sessionRef.current?.address ?? "").toLowerCase()) {
          say(`wallet switched to ${next} — this onboarding belongs to another account`);
        }
      },
      onChainChanged: () => say("wallet changed network — it will be switched back when you sign"),
    });
  }, [session, say]);

  // On reload, a wallet the person already approved can be read back without a
  // prompt. A session that says "metamask" but whose extension has since been
  // disconnected is reported rather than silently falling back to a local key,
  // which would sign as a different address.
  useEffect(() => {
    if (!session?.address) return;
    void (async () => {
      const active = await silentAccount();
      if (active && active.toLowerCase() !== session.address!.toLowerCase()) {
        say(`wallet is on ${active}; this onboarding belongs to ${session.address}`);
      }
    })();
  }, [session, say]);

  // --- onboarding ----------------------------------------------------------

  const onboard = useCallback(
    () =>
      act("onboard", async () => {
        if (!session) throw new Error("session not ready");
        const t = await token();
        // Resolved before anything is created. In MetaMask mode this is where a
        // locked extension, a switched account or the wrong network surfaces —
        // better here than three API calls into an onboarding that then binds
        // the wrong address.
        const signer = await resolveSigner();

        // 1. the vendor record
        stage("vendor", { state: "running" });
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
          stage("vendor", { state: "ok", detail: `created ${vendorId}` });
        } else {
          stage("vendor", { state: "ok", detail: `existing ${vendorId}` });
        }

        // 2. DigiLocker, with a real human consent in the middle.
        //
        // "Already done" is a property of the VENDOR, not of the session. An
        // earlier version asked the session, which reports `succeeded` the
        // moment a human consents — so a resumed run skipped
        // `identity/complete`, the call that actually fetches the documents and
        // writes the identity.
        stage("identity", { state: "running" });
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
            stage("identity", { state: "running", detail: "waiting for your consent" });

            // Same loop the console runs — see lib/digilocker.ts. The messages
            // stay this page's own, because they are what the payee reads.
            const outcome = await pollConsent({
              vendorId,
              token: t,
              onDeadline: setConsentDeadline,
            });
            if (outcome === "failed" || outcome === "expired") {
              throw new Error(`DigiLocker session ${outcome}`);
            }
            if (outcome === "timeout") {
              throw new Error("timed out waiting for DigiLocker consent");
            }
            setConsentUrl(null);
            setConsentDeadline(null);
          } else {
            say("consent already given — completing it");
            stage("identity", { state: "running", detail: "consent already given" });
          }

          const done = await api(`/vendors/${vendorId}/identity/complete`, {
            method: "POST",
            token: t,
          });
          if (!done.ok) throw new Error(`identity/complete → ${messageOf(done.body)}`);
          say("DigiLocker verified");
          stage("identity", { state: "ok", detail: "documents pulled and checked" });
        } else {
          say("identity already verified");
          stage("identity", { state: "ok", detail: "already verified — nothing to redo" });
        }

        // 3-6. register the address, prove the key, bind it to the verified
        // identity, confirm out of band, and put it on the token's KYC list.
        //
        // Shared with the payer's setup rather than written twice: the payer
        // funds escrows from their own wallet now, so their address passes the
        // same four gates, and two copies of a security sequence is two places
        // for one gate to quietly go missing.
        await onboardWallet({
          vendorId,
          signer,
          token: t,
          chainId,
          walletId: vendorId === session.vendorId ? session.walletId : null,
          confirmedBy: "payee-page",
          onWalletRegistered: (walletId) => update({ walletId }),
          report: {
            say,
            stage: (id, state, detail) =>
              stage(id, { state, ...(detail ? { detail } : {}) }),
          },
        });
      }).catch(() => {
        /* act() already recorded it; this only stops the rejection escaping */
      }),
    [act, session, legalName, token, update, say, stage, chainId],
  );

  // --- incoming payments ---------------------------------------------------

  // One cycle at a time, and never two of the same cycle chasing each other.
  const cycleRef = useRef<Promise<void> | null>(null);
  const failuresRef = useRef(0);

  /**
   * One poll cycle.
   *
   * WHAT THIS USED TO DO, and why it could not keep up. It called the
   * notifications endpoint, then awaited a consent-prompt request per unread id
   * INSIDE a `for` loop, then called the same notifications endpoint a second
   * time without the unread filter, then awaited a settlement request per id in
   * another `for` loop. With twenty notifications that is about forty-two
   * sequential round trips. At 120ms each the cycle takes longer than the
   * five-second interval that started it, so cycles overlapped and the pile
   * grew for as long as the tab stayed open.
   *
   * Three changes, none of which need the API to move:
   *
   *   ONE notifications call, not two. Every row carries `readAt`, so the unread
   *   set the consent prompts come from is a client-side filter over the full
   *   list rather than a second request for the same data.
   *
   *   The two fan-outs run concurrently with each other, and each one runs six
   *   at a time instead of one at a time. Six keeps the burst inside a single
   *   tick without opening so many sockets that the tunnel starts queueing.
   *
   *   The fan-out is capped. A payee with two hundred notifications is not a
   *   reason to make two hundred requests every few seconds; the rest can be
   *   paginated on demand when there is a screen that needs them.
   *
   * `Promise.allSettled` semantics throughout: one payment whose settlement
   * lookup fails must not remove the other nineteen from the screen.
   */
  const runCycle = useCallback(
    async (signal?: AbortSignal) => {
      if (!session?.vendorId) return;
      try {
        const t = await token();
        const all = await api(`/vendors/${session.vendorId}/notifications`, {
          token: t,
          signal,
        });
        if (!all.ok) throw new Error(messageOf(all.body));

        const rows = all.body as {
          kind: string;
          paymentRequestId: string | null;
          readAt: string | null;
        }[];

        const promptIds = [
          ...new Set(
            rows
              .filter((r) => r.kind === "CONSENT_REQUESTED" && r.readAt === null && r.paymentRequestId)
              .map((r) => r.paymentRequestId as string),
          ),
        ].slice(0, POLL_FANOUT_CAP);

        // Money already locked FOR this payee. It is not in their possession
        // until they claim it, so it needs to be visible and actionable — an
        // escrow nobody claims refunds to the sender.
        const settlementIds = [
          ...new Set(
            rows.map((r) => r.paymentRequestId).filter((v): v is string => Boolean(v)),
          ),
        ].slice(0, POLL_FANOUT_CAP);

        const [prompts, settlements] = await Promise.all([
          mapWithLimit(promptIds, POLL_CONCURRENCY, (id) =>
            api(`/payments/${id}/consent-prompt`, { token: t, signal }),
          ),
          mapWithLimit(settlementIds, POLL_CONCURRENCY, async (id) => ({
            id,
            call: await api(`/payments/${id}/settlement`, { token: t, signal }),
          })),
        ]);

        if (signal?.aborted) return;

        setIncoming(
          prompts.flatMap((r) =>
            r.status === "fulfilled" && r.value.ok ? [r.value.body as Incoming] : [],
          ),
        );
        setEscrows(
          settlements.flatMap((r) =>
            r.status === "fulfilled" && r.value.call.ok
              ? [{ paymentRequestId: r.value.id, ...(r.value.call.body as object) } as Escrow]
              : [],
          ),
        );

        failuresRef.current = 0;
        setPolledAt(Date.now());
        setPollFailed(false);
      } catch (err) {
        // An abort is this hook cancelling its own work on unmount or on a
        // session change. It is not the API being down and must not be reported
        // as such, or every navigation would light up the poll indicator.
        if (signal?.aborted || (err as { name?: string } | null)?.name === "AbortError") return;
        // A failed poll is not worth interrupting the page for — but it is worth
        // SAYING, or a dead API is indistinguishable from an empty inbox.
        failuresRef.current += 1;
        setPolledAt(Date.now());
        setPollFailed(true);
      }
    },
    [session?.vendorId, token],
  );

  /**
   * Run a cycle, coalescing with whatever is already in flight.
   *
   * An interval tick that arrives mid-cycle joins the running one rather than
   * starting a second. A caller that has just WRITTEN something — claiming an
   * escrow, accepting a payment — passes `force`, because the running cycle may
   * have read the API before their write landed; it waits for that cycle to
   * drain and then runs its own.
   */
  const refresh = useCallback(
    (opts: { signal?: AbortSignal | undefined; force?: boolean } = {}) => {
      const running = cycleRef.current;
      if (running && !opts.force) return running;
      const next = (running ?? Promise.resolve())
        .then(() => runCycle(opts.signal))
        .finally(() => {
          if (cycleRef.current === next) cycleRef.current = null;
        });
      cycleRef.current = next;
      return next;
    },
    [runCycle],
  );

  useEffect(() => {
    if (!session?.vendorId) return;

    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Self-scheduling rather than `setInterval`: the next cycle is booked when
    // the previous one finishes, so overlap is impossible by construction
    // rather than by a guard that has to hold.
    const nextDelay = () =>
      failuresRef.current >= POLL_FAILURES_BEFORE_BACKOFF
        ? POLL_BACKOFF_MS
        : document.hidden
          ? POLL_HIDDEN_MS
          : POLL_ACTIVE_MS;

    const tick = async () => {
      await refresh({ signal: ctl.signal });
      if (!ctl.signal.aborted) timer = setTimeout(() => void tick(), nextDelay());
    };

    void tick();

    // Returning to the tab must not show up to thirty seconds of stale
    // "waiting" while the backed-off timer runs down.
    const onVisibility = () => {
      if (document.hidden || ctl.signal.aborted) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      ctl.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session?.vendorId, refresh]);

  const claim = useCallback(
    (escrow: Escrow) =>
      act(`claim ${escrow.paymentRequestId}`, async () => {
        if (!session) throw new Error("session not ready");
        const t = await token();
        const { claimTxHash } = await claimEscrow({
          paymentId: escrow.paymentRequestId,
          signer: await resolveSigner(),
          token: t,
          report: (line) => {
            say(line);
            setClaimStage((s) => ({ ...s, [escrow.paymentRequestId]: line }));
          },
        });
        say(`claimed — ${claimTxHash}`);
        setClaimStage((s) => {
          const next = { ...s };
          delete next[escrow.paymentRequestId];
          return next;
        });
        // Forced: this follows a write, and a cycle already in flight may have
        // read the API before that write landed.
        await refresh({ force: true });
      }).catch(() => {
        setClaimStage((s) => {
          const next = { ...s };
          delete next[escrow.paymentRequestId];
          return next;
        });
      }),
    [act, session, token, say, refresh, resolveSigner],
  );

  const decide = useCallback(
    (payment: Incoming, decision: "ACCEPTED" | "DENIED") =>
      act(
        `${decision === "ACCEPTED" ? "accept" : "deny"} ${payment.paymentRequestId}`,
        async () => {
          if (!session) throw new Error("session not ready");

          if (decision === "DENIED") {
            const res = await api(`/payments/${payment.paymentRequestId}/consent`, {
              method: "POST",
              body: { decision: "DENIED" },
            });
            if (!res.ok) throw new Error(messageOf(res.body));
            // Forced: this follows a write, and a cycle already in flight may have
        // read the API before that write landed.
        await refresh({ force: true });
            return;
          }

          // Signed by the payout address, over this exact amount and invoice —
          // so a captured signature cannot wave through a different payment.
          // Resolved here rather than above: a refusal needs no signature, so a
          // locked wallet must not stop someone declining a payment.
          const signer = await resolveSigner();
          const signature = await signer.client.signTypedData({
            account: signer.address,
            domain: domainFor(chainId),
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
              signerAddress: signer.address,
              ...(worldId ? { worldIdVerificationId: worldId } : {}),
            },
          });
          if (!res.ok) throw new Error(messageOf(res.body));
          // Forced: this follows a write, and a cycle already in flight may have
        // read the API before that write landed.
        await refresh({ force: true });
        },
      ).catch(() => {
        /* already recorded */
      }),
    [act, session, worldIdForPayment, refresh, chainId],
  );

  const resetBrowserSession = useCallback(() => {
    clearAccount();
    window.location.reload();
  }, []);

  return {
    session,
    legalName,
    setLegalName,
    busy,
    error,
    log,
    consentUrl,
    consentDeadline,
    incoming,
    escrows,
    stages,
    claimStage,
    polledAt,
    pollFailed,
    worldIdForPayment,
    setWorldIdForPayment,
    onboard,
    claim,
    decide,
    refresh,
    update,
    resetBrowserSession,

    // --- wallet ---
    /** "metamask" once connected, "local" for a key generated in this tab. */
    walletMode: "metamask" as const,
    /** The payout address, or null when the wallet has not been connected. */
    address: session?.address ?? null,
    /** False when no extension is installed, which the UI must say plainly. */
    walletAvailable,
    /** Locked once a wallet is confirmed — changing it would orphan the binding. */
    walletLocked: Boolean(session?.walletId),
    connect,
  };
}
