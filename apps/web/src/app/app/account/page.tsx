"use client";

// Your account. One setup, both directions.
//
// Six things have to be true before this account can pay anyone or be paid, and
// they prove different facts that do not substitute for each other: a record
// exists, a government authority says who you are, you hold the key to the
// address, that key is bound to that identity, an independent channel confirmed
// it, and the token itself will accept you.
//
// THE SAME SIX EITHER WAY, which is why this screen replaced a separate "set up
// your organisation". The token gates transfers on both sides, so a sender
// needs the KYC grant as much as a recipient; the escrow refunds to whoever
// funded it, so a sender's address is a destination too. Running the six twice
// was never possible anyway — a DigiLocker identity backs exactly one vendor.
//
// The payout key is YOURS, and that is the entire reason this is a separate
// side of the product rather than something a payer sets up on your behalf — a
// key they hold is not a key you control, and your acceptance of a payment
// would prove nothing.
//
// Connecting MetaMask is the real version of that claim: the key never reaches
// this page at all. The generated-key mode it replaces is still available,
// because the demo has to run with no extension installed, but it is the
// weaker claim and the UI says so.

import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { ActivityLog } from "../../../components/app/payee/ActivityLog";
import { WalletCard } from "../../../components/app/WalletCard";
import { BalanceCard } from "../../../components/app/BalanceCard";
import { STAGES } from "../../../hooks/usePayeeFlow";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Field } from "../../../components/ui/Field";
import { Panel } from "../../../components/ui/Surface";
import { StatusPill } from "../../../components/ui/StatusPill";
import { StepGlyph } from "../../../components/ui/StepGlyph";
import { Countdown } from "../../../components/ui/Timing";
import { WorldIdStep } from "../../../components/ui/WorldIdStep";

export default function IdentityPage() {
  const { payee } = useApp();
  const session = payee.session;

  if (!session) {
    return (
      <>
        <PageHeader title="My identity" />
        <Panel className="h-48 animate-pulse opacity-40">
          <span className="sr-only">Preparing your session</span>
        </Panel>
      </>
    );
  }

  // The payout address comes from the FLOW, not from the stored key: in
  // MetaMask mode the stored key is present and unused, and showing the
  // address derived from it would name an account nothing is ever paid to.
  const address = payee.address;
  const onboarded = Boolean(session.vendorId && session.walletId);
  const onboarding = payee.busy === "onboard";

  return (
    <>
      <PageHeader
        title="Your account"
        lead="Set this up once. Connect the wallet this account pays from and is paid into, then prove it is yours."
        actions={onboarded ? <StatusPill tone="ok">onboarded</StatusPill> : undefined}
      />

      {payee.error && (
        <Alert tone="error" className="mb-4">
          {payee.error}
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="space-y-4">
          {/* First, because the address is what every step below is ABOUT. */}
          <WalletCard
            title="Your wallet"
            lead="One address. It funds the escrows you pay and receives the ones you are paid, and it makes every signature below."
            mode={payee.walletMode}
            address={payee.address}
            available={payee.walletAvailable}
            locked={payee.walletLocked}
            connecting={payee.busy === "connect wallet"}
            disabled={payee.busy !== null}
            onConnect={() => void payee.connect()}
            lockedNote="This account is bound to the address above. Reset the browser session to start again with a different one."
          />

          <Panel className="p-5">
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-mist-400">
                Your legal entity name
              </span>
              <input
                value={payee.legalName}
                placeholder="e.g. your company's registered name"
                onChange={(e) => payee.setLegalName(e.target.value)}
                disabled={Boolean(session.vendorId)}
                className="well w-full px-3 py-2 text-[13.5px] text-mist-50 placeholder:text-mist-600 disabled:opacity-60"
              />
            </label>
            <p className="mt-1.5 text-[11.5px] text-mist-600">
              A label only. What a payer is matched against comes from DigiLocker, not this field.
            </p>

            {/* Gated on an address. Onboarding registers a payout wallet as its
                third step, so starting without one would fail several API calls
                in, after a DigiLocker consent has already been spent. */}
            <Button
              variant="primary"
              className="mt-4"
              onClick={() => void payee.onboard()}
              disabled={!payee.address || (payee.busy !== null && !onboarding)}
              busy={onboarding}
            >
              {onboarding ? "Setting up…" : onboarded ? "Re-run onboarding" : "Start onboarding"}
            </Button>

            {payee.consentUrl && (
              <Alert
                tone="warn"
                className="mt-3"
                title="Waiting for your DigiLocker consent"
                action={
                  payee.consentDeadline !== null ? (
                    <Countdown deadline={payee.consentDeadline} expired="deadline passed" />
                  ) : undefined
                }
              >
                Tab did not open?{" "}
                <a
                  href={payee.consentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-signal-400 underline underline-offset-4 hover:text-signal-300"
                >
                  open DigiLocker
                </a>
              </Alert>
            )}

            <div className="mt-5">
              <h2 className="mb-2 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
                What setting up does
              </h2>
              <ol className="space-y-1">
                {STAGES.map((stage, i) => {
                  const record = payee.stages[stage.id];
                  // Enrolment has no runner to report it, so its state comes
                  // from the record itself: an enrolment id means it is done.
                  const state =
                    stage.id === "enrol"
                      ? session.enrolmentId
                        ? "ok"
                        : (record?.state ?? "waiting")
                      : (record?.state ?? "idle");
                  return (
                    <li
                      key={stage.id}
                      className={`flex items-start gap-3 rounded-md border px-3 py-2 ${
                        state === "idle"
                          ? "border-hairline bg-white/[0.01]"
                          : "border-hairline-strong bg-white/[0.02]"
                      }`}
                    >
                      <span className="pt-px">
                        <StepGlyph tone={state} size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono text-[10.5px] text-mist-600">{i + 1}</span>
                          <span className="text-[12.5px] font-medium text-mist-100">
                            {stage.title}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed text-mist-500">
                          {stage.proves}
                        </p>
                        {record?.detail && (
                          <p
                            className={`mt-1 font-mono text-[11px] break-all ${
                              state === "failed" ? "text-halt-400" : "text-signal-300"
                            }`}
                          >
                            {record.detail}
                          </p>
                        )}

                        {/* In the row, not beside it. This is the one step a
                            person performs rather than watches, and putting the
                            control anywhere else is what made it look optional. */}
                        {stage.id === "enrol" && session.vendorId && (
                          <div className="mt-2.5">
                            {session.enrolmentId ? (
                              <p className="font-mono text-[11px] break-all text-verified-400">
                                {session.enrolmentId}
                              </p>
                            ) : (
                              <WorldIdStep
                                title="Enrol (O7)"
                                purpose="ENROLLMENT"
                                signal={`enrol:${session.vendorId}`}
                                subject={session.vendorId}
                                onVerified={(id) => payee.update({ enrolmentId: id })}
                              />
                            )}
                          </div>
                        )}
                        {stage.id === "enrol" && !session.vendorId && (
                          <p className="mt-1 text-[11.5px] text-mist-600">
                            Available once the steps above have created your record.
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </Panel>

          <Panel className="p-5">
            <h2 className="mb-2 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
              Activity
            </h2>
            <ActivityLog lines={payee.log} />
          </Panel>
        </div>

        <aside className="space-y-4">
          {/* Only once there is an address to ask about. */}
          {address && <BalanceCard address={address} />}

          <Panel className="p-4">
            <h2 className="mb-3 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
              Your record
            </h2>
            <Field k="Vendor id" v={session.vendorId} copy />
            <Field k="Payout address" v={address} mono copy />
            <Field k="Wallet row" v={session.walletId} copy />
            <Field k="World ID" v={session.enrolmentId} />
          </Panel>

          {onboarded && (
            <Panel className="border-dashed border-signal-500/30 p-4">
              <h2 className="mb-3 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
                Send these to the payer
              </h2>
              <Field k="Vendor id" v={session.vendorId} mono copy />
              <Field k="Payout address" v={address} mono copy />
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 w-full"
                onClick={() =>
                  void navigator.clipboard?.writeText(
                    `vendorId: ${session.vendorId}\naddress: ${address ?? ""}`,
                  )
                }
              >
                Copy both
              </Button>
            </Panel>
          )}

          <Panel className="p-4">
            <Button
              variant="halt"
              size="sm"
              className="w-full"
              onClick={() => {
                if (
                  window.confirm(
                    "This mints a new payout key. The vendor you onboarded stays on the server, but you will no longer be able to sign for it. Continue?",
                  )
                ) {
                  payee.resetBrowserSession();
                }
              }}
            >
              Log out
            </Button>
            <p className="mt-2 text-[11px] leading-relaxed text-mist-600">
              Your key lives only here. Clearing site data loses it, and nobody — including us —
              can recover it for you.
            </p>
          </Panel>
        </aside>
      </div>
    </>
  );
}
