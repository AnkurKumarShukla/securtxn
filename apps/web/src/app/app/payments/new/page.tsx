"use client";

// Raising a payment.
//
// FOUR STEPS, AND THE ORDER IS NOT A DESIGN CHOICE. The services enforce it:
// the World ID check's signal is `sender:<paymentId>`, so the payment has to
// exist before the check can be taken, and `request-consent` refuses outright
// unless that check is already recorded against this payment. A wizard that
// asked for the selfie first would produce a proof that no payment could
// consume.
//
//   1  Who you are paying        — the address, off the invoice. UNTRUSTED.
//   2  What you are paying       — amount, invoice reference, settlement mode
//   3  Who you believe they are  — the claim the whole match is built on
//   4  Confirm and raise         — creates it (P1), then your check (P2),
//                                  then notifies the payee (P3)
//
// Step 3 is the one that matters and the one a normal payments product does not
// have. A tampered invoice carries the attacker's address; stating who you
// INTEND to pay is what makes that address falsifiable.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { VendorListItem } from "@cp/shared-types";
import { api, messageOf, senderSignal } from "../../../../lib/flow";
import { listVendors } from "../../../../lib/api-client";
import { useApp } from "../../../../components/app/AppProvider";
import { PageHeader } from "../../../../components/app/shell/Page";
import { Alert } from "../../../../components/ui/Alert";
import { Button } from "../../../../components/ui/Button";
import { Field } from "../../../../components/ui/Field";
import { Hash } from "../../../../components/ui/Mono";
import { Panel } from "../../../../components/ui/Surface";
import { StepGlyph } from "../../../../components/ui/StepGlyph";
import { WorldIdStep } from "../../../../components/ui/WorldIdStep";

const STEPS = [
  { title: "Payee", lead: "Who is receiving the money" },
  { title: "Amount", lead: "What you are paying, and how" },
  { title: "Verification", lead: "Who you believe they are" },
  { title: "Confirm", lead: "Raise it and notify them" },
];

export default function NewPaymentPage() {
  const { token, org, orgReady, ready } = useApp();
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1
  const [payees, setPayees] = useState<VendorListItem[] | null>(null);
  const [payeeId, setPayeeId] = useState("");
  const [manualId, setManualId] = useState("");
  const [wallet, setWallet] = useState<{ walletId: string; address: string; network: string } | null>(null);

  // Step 2
  const [amount, setAmount] = useState("500.00");
  const [asset, setAsset] = useState("stUSDC");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [mode, setMode] = useState<"DIRECT" | "HTLC">("HTLC");

  // Step 3
  const [claimedName, setClaimedName] = useState("");
  const [claimedPan, setClaimedPan] = useState("");

  // Step 4
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [worldIdDone, setWorldIdDone] = useState(false);

  // Only vendors who can actually be paid. A directory that offers a payee with
  // no confirmed wallet is a directory that sets up a failure four steps later.
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      try {
        const t = await token();
        const result = await listVendors(t, { payableOnly: true, limit: 100 });
        setPayees(result.items.filter((v) => v.id !== org.vendorId));
      } catch {
        setPayees([]);
      }
    })();
  }, [ready, token, org.vendorId]);

  useEffect(() => {
    // A reference is generated rather than left blank: it must be unique per
    // payment (a duplicate is one of the decision engine's refusals), and
    // asking someone to invent one is asking them to collide.
    if (!invoiceRef) setInvoiceRef(`INV-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`);
  }, [invoiceRef]);

  /** Reads the payee's CONFIRMED wallet. The address is never typed by hand. */
  const resolvePayee = useCallback(
    async (vendorId: string) => {
      setError(null);
      setWallet(null);
      const t = await token();
      const call = await api(`/vendors/${vendorId}/wallets`, { token: t });
      if (!call.ok) throw new Error(`read payee wallets → ${messageOf(call.body)}`);
      const wallets = call.body as {
        walletId?: string;
        id?: string;
        address: string;
        status: string;
        network: string;
      }[];
      const confirmed = wallets.find((w) => w.status === "CONFIRMED");
      if (!confirmed) {
        throw new Error(
          `This payee has no confirmed wallet yet (${wallets.length} registered). They finish that on their own side.`,
        );
      }
      const id = confirmed.walletId ?? confirmed.id;
      if (!id) throw new Error("the payee's wallet has no id");
      setWallet({ walletId: id, address: confirmed.address, network: confirmed.network });
      // Prefill the claim with the name on file, so the operator edits a real
      // value rather than typing one from nothing. It is still THEIR claim —
      // they are expected to check it against the invoice in front of them.
      const chosen = payees?.find((p) => p.id === vendorId);
      if (chosen && !claimedName) setClaimedName(chosen.displayName);
    },
    [token, payees, claimedName],
  );

  const chooseAndAdvance = useCallback(async () => {
    const id = (payeeId || manualId).trim();
    if (!id) {
      setError("Choose a payee, or paste the vendor id they sent you.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolvePayee(id);
      setPayeeId(id);
      setStep(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [payeeId, manualId, resolvePayee]);

  /** P1. Creates the payment so the World ID check has something to bind to. */
  const raise = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (!wallet) throw new Error("the payee's wallet has not been resolved");
      if (!org.vendorId) throw new Error("your organisation is not set up");
      const t = await token();
      const body = {
        vendorId: payeeId,
        vendorWalletId: wallet.walletId,
        payerVendorId: org.vendorId,
        intendedPayeeName: claimedName,
        intendedPayeePan: claimedPan,
        invoiceRef,
        amount,
        token: asset,
        network: wallet.network,
        settlementMode: mode,
      };
      const call = await api("/payments", { method: "POST", token: t, body });
      if (!call.ok) throw new Error(`create payment → ${messageOf(call.body)}`);
      setPaymentId((call.body as { id: string }).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wallet, org.vendorId, token, payeeId, claimedName, claimedPan, invoiceRef, amount, asset, mode]);

  /** P3. Refused unless P2 is already recorded against this payment. */
  const notify = useCallback(async () => {
    if (!paymentId) return;
    setBusy(true);
    setError(null);
    try {
      const t = await token();
      const call = await api(`/payments/${paymentId}/request-consent`, {
        method: "POST",
        token: t,
      });
      if (!call.ok) throw new Error(`notify the payee → ${messageOf(call.body)}`);
      router.push(`/app/payments/${paymentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [paymentId, token, router]);

  if (ready && !orgReady) {
    return (
      <>
        <PageHeader title="New payment" back={{ href: "/app/payments", label: "Payments" }} />
        <Alert
          tone="warn"
          title="Set up your organisation first"
          action={
            <Button variant="primary" size="sm" onClick={() => router.push("/app/account")}>
              Set up
            </Button>
          }
        >
          A payment names who is making it, and the payee's decision engine checks how far that
          party got through their own identity checks.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New payment"
        lead="Four steps. The third is the one that makes a tampered invoice fail."
        back={{ href: "/app/payments", label: "Payments" }}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <Panel className="p-5 sm:p-6">
          <Rail step={step} />

          {error && (
            <Alert tone="error" className="mb-4">
              {error}
            </Alert>
          )}

          {step === 0 && (
            <section>
              <Heading title="Who are you paying?" lead="They must have finished onboarding on their own side, with their own key." />

              {payees === null ? (
                <div className="h-24 animate-pulse rounded-md bg-white/[0.03]" />
              ) : payees.length > 0 ? (
                <ul className="space-y-1.5">
                  {payees.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPayeeId(p.id);
                          setManualId("");
                        }}
                        className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-[--dur-fast] ${
                          payeeId === p.id
                            ? "border-signal-500/50 bg-signal-500/[0.08]"
                            : "border-hairline hover:border-hairline-active"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-mist-50">
                            {p.displayName}
                          </span>
                          <span className="mt-0.5 block font-mono text-[11px] text-mist-500">
                            {p.payoutAddress ? <Hash value={p.payoutAddress} copy={false} /> : "no address"}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 font-mono text-[10px] tracking-[0.06em] uppercase ${
                            p.verificationTier === "TIER0_UNVERIFIED"
                              ? "text-pending-400"
                              : "text-verified-400"
                          }`}
                        >
                          {p.verificationTier.replace("TIER", "T").replace("_", " ")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Alert tone="info">
                  No payable counterparties yet. A payee appears here once they have onboarded and
                  their wallet is confirmed.
                </Alert>
              )}

              <label className="mt-4 block">
                <span className="mb-1.5 block text-[12px] text-mist-400">
                  Or paste a vendor id they sent you
                </span>
                <input
                  value={manualId}
                  onChange={(e) => {
                    setManualId(e.target.value);
                    setPayeeId("");
                  }}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="well w-full px-3 py-2 font-mono text-[12.5px] text-mist-100 placeholder:text-mist-600"
                />
              </label>

              <Nav
                onNext={() => void chooseAndAdvance()}
                nextLabel="Continue"
                busy={busy}
                disabled={!payeeId && !manualId.trim()}
              />
            </section>
          )}

          {step === 1 && (
            <section>
              <Heading title="What are you paying?" lead="The settlement mode is part of what an approver approves, so it is chosen now rather than at the end." />

              <div className="grid gap-3 sm:grid-cols-2">
                <Labelled label="Amount">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    className="well w-full px-3 py-2 text-[14px] tabular-nums text-mist-50"
                  />
                </Labelled>
                <Labelled label="Asset">
                  <input
                    value={asset}
                    onChange={(e) => setAsset(e.target.value.toUpperCase())}
                    className="well w-full px-3 py-2 font-mono text-[13px] text-mist-50"
                  />
                </Labelled>
              </div>

              <Labelled label="Invoice reference" className="mt-3">
                <input
                  value={invoiceRef}
                  onChange={(e) => setInvoiceRef(e.target.value)}
                  className="well w-full px-3 py-2 font-mono text-[13px] text-mist-50"
                />
              </Labelled>
              <p className="mt-1.5 text-[11.5px] text-mist-600">
                Must be unique. A repeat of one you have already paid is refused as a duplicate.
              </p>

              <fieldset className="mt-5">
                <legend className="mb-2 text-[12px] text-mist-400">How it settles</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice
                    checked={mode === "HTLC"}
                    onSelect={() => setMode("HTLC")}
                    title="Escrow"
                    body="Locked against a secret. The payee collects by revealing it, and if they never do, the money comes back to you."
                    recommended
                  />
                  <Choice
                    checked={mode === "DIRECT"}
                    onSelect={() => setMode("DIRECT")}
                    title="Direct"
                    body="Sent outright. Faster, and there is no undo."
                  />
                </div>
              </fieldset>

              <Nav onBack={() => setStep(0)} onNext={() => setStep(2)} nextLabel="Continue" disabled={!amount.trim() || !invoiceRef.trim()} />
            </section>
          )}

          {step === 2 && (
            <section>
              <Heading
                title="Who do you believe they are?"
                lead="Read these off the invoice in front of you, not off their profile. This is the check a tampered invoice fails."
              />

              <Alert tone="info" className="mb-4">
                The address above came off an invoice, and an invoice is exactly where tampering
                lives. Stating who you INTEND to pay lets the enclave compare that claim against
                the identity behind the address. They disagree, the payment is blocked, and you
                never find out anything about them beyond match or no match.
              </Alert>

              <Labelled label="Intended payee name">
                <input
                  value={claimedName}
                  onChange={(e) => setClaimedName(e.target.value)}
                  placeholder="as written on the invoice"
                  className="well w-full px-3 py-2 text-[13.5px] text-mist-50 placeholder:text-mist-600"
                />
              </Labelled>

              <Labelled label="Intended payee PAN" className="mt-3">
                <input
                  value={claimedPan}
                  onChange={(e) => setClaimedPan(e.target.value.toUpperCase())}
                  placeholder="ABCDE1234F"
                  maxLength={10}
                  className="well w-full px-3 py-2 font-mono text-[13.5px] tracking-[0.08em] text-mist-50 placeholder:text-mist-600"
                />
              </Labelled>
              <p className="mt-1.5 text-[11.5px] text-mist-600">
                Sent as a digest, never in the clear. Neither we nor the enclave ever hold the
                number itself.
              </p>

              <Nav
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
                nextLabel="Review"
                disabled={!claimedName.trim() || !claimedPan.trim()}
              />
            </section>
          )}

          {step === 3 && (
            <section>
              <Heading title="Confirm and raise" lead="Nothing has been created yet and no money moves at this step." />

              <div className="mb-5">
                <Field k="Paying" v={payees?.find((p) => p.id === payeeId)?.displayName ?? payeeId} />
                <Field k="To address" v={wallet?.address ?? null} mono />
                <Field k="Amount" v={`${amount} ${asset}`} />
                <Field k="Invoice" v={invoiceRef} mono />
                <Field k="Settles" v={mode === "HTLC" ? "Escrow — recoverable" : "Direct — no undo"} />
                <Field k="You claim they are" v={claimedName} />
                <Field k="With PAN" v={claimedPan} mono />
              </div>

              {!paymentId ? (
                <>
                  <Button variant="primary" onClick={() => void raise()} busy={busy}>
                    Raise this payment
                  </Button>
                  <Button variant="quiet" className="ml-2" onClick={() => setStep(2)} disabled={busy}>
                    Back
                  </Button>
                </>
              ) : (
                <div className="space-y-4">
                  <Alert tone="info" title="Payment raised">
                    It exists as a draft. Nothing has been sent to the payee and no money has
                    moved.
                  </Alert>

                  <div>
                    <h3 className="mb-2 text-[13px] font-medium text-mist-100">
                      Confirm a live human raised it
                    </h3>
                    <p className="mb-3 text-[12px] leading-relaxed text-mist-500">
                      Required for every payment. The check is bound to this payment specifically,
                      so it cannot be reused for another.
                    </p>
                    <WorldIdStep
                      title="Your check for this payment (P2)"
                      purpose="REVERIFICATION"
                      signal={senderSignal(paymentId)}
                      subject={org.vendorId ?? ""}
                      onVerified={() => setWorldIdDone(true)}
                    />
                  </div>

                  <Button
                    variant="primary"
                    onClick={() => void notify()}
                    busy={busy}
                    disabled={!worldIdDone}
                  >
                    Notify the payee
                  </Button>
                  {!worldIdDone && (
                    <p className="text-[11.5px] text-mist-600">
                      The payee cannot be asked until your check is recorded. The service refuses
                      it, not this screen.
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </Panel>

        <aside className="hidden lg:block">
          <Panel className="p-4">
            <h2 className="mb-3 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
              This payment
            </h2>
            <Field k="Payee" v={payees?.find((p) => p.id === payeeId)?.displayName ?? null} />
            <Field k="Address" v={wallet?.address ?? null} mono />
            <Field k="Network" v={wallet?.network ?? null} />
            <Field k="Amount" v={step >= 1 ? `${amount} ${asset}` : null} />
            <Field k="Invoice" v={step >= 1 ? invoiceRef : null} />
            <Field k="Settles" v={step >= 1 ? mode : null} />
            <Field k="Payment id" v={paymentId} copy />
          </Panel>
        </aside>
      </div>
    </>
  );
}

function Rail({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex items-center gap-1.5">
      {STEPS.map((s, i) => (
        <li key={s.title} className="flex min-w-0 flex-1 items-center gap-2">
          <StepGlyph tone={i < step ? "ok" : i === step ? "running" : "idle"} size={16} />
          <span
            className={`hidden truncate text-[12px] sm:block ${
              i === step ? "text-mist-50" : i < step ? "text-mist-400" : "text-mist-600"
            }`}
          >
            {s.title}
          </span>
          {i < STEPS.length - 1 && (
            <span
              aria-hidden
              className={`h-px flex-1 ${i < step ? "bg-verified-400/40" : "bg-white/10"}`}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function Heading({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[17px] font-semibold tracking-tight text-mist-50">{title}</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-mist-500">{lead}</p>
    </div>
  );
}

function Labelled({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[12px] text-mist-400">{label}</span>
      {children}
    </label>
  );
}

function Choice({
  checked,
  onSelect,
  title,
  body,
  recommended,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`rounded-md border px-3 py-3 text-left transition-colors duration-[--dur-fast] ${
        checked ? "border-signal-500/50 bg-signal-500/[0.08]" : "border-hairline hover:border-hairline-active"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-mist-50">{title}</span>
        {recommended && (
          <span className="rounded border border-verified-400/30 bg-verified-400/10 px-1.5 py-px font-mono text-[9.5px] tracking-[0.06em] text-verified-400 uppercase">
            recoverable
          </span>
        )}
      </span>
      <span className="mt-1 block text-[11.5px] leading-relaxed text-mist-500">{body}</span>
    </button>
  );
}

function Nav({
  onBack,
  onNext,
  nextLabel,
  busy,
  disabled,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="mt-6 flex items-center gap-2">
      <Button variant="primary" onClick={onNext} busy={busy} disabled={disabled}>
        {nextLabel}
      </Button>
      {onBack && (
        <Button variant="quiet" onClick={onBack} disabled={busy}>
          Back
        </Button>
      )}
    </div>
  );
}
