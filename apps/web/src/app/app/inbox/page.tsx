"use client";

// What has been sent to you, and the decision only you can make.
//
// NOTHING ABOUT YOU IS CHECKED UNTIL YOU ACCEPT. That is the control, not a
// courtesy: it is what stops the identity match being a free lookup oracle
// somebody can probe. Denying costs you nothing, needs no signature, and stops
// the payment dead.

import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { IncomingCard } from "../../../components/app/payee/IncomingCard";
import { PollIndicator } from "../../../components/app/payee/PollIndicator";
import { Alert } from "../../../components/ui/Alert";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Panel } from "../../../components/ui/Surface";

export default function InboxPage() {
  const { payee } = useApp();
  const session = payee.session;
  const onboarded = Boolean(session?.vendorId && session?.walletId);

  return (
    <>
      <PageHeader
        title="Incoming"
        lead="Payments addressed to you. Accepting signs with the key in this browser; refusing needs no signature."
        actions={
          session?.vendorId ? (
            <PollIndicator
              at={payee.polledAt}
              failed={payee.pollFailed}
              // Forced: someone pressed "check now" and is owed a fresh read,
              // not whichever cycle happened to already be running.
              onCheck={() => void payee.refresh({ force: true })}
            />
          ) : undefined
        }
      />

      {payee.error && (
        <Alert tone="error" className="mb-4">
          {payee.error}
        </Alert>
      )}

      {!onboarded ? (
        <Panel className="p-6">
          <EmptyState title="Finish onboarding first">
            A payment is addressed to a vendor record with a confirmed payout address. Set yours up
            under My identity, then send the payer your vendor id.
          </EmptyState>
        </Panel>
      ) : payee.incoming.length === 0 ? (
        <Panel className="p-6">
          <EmptyState title="Nothing waiting">
            This checks every 5 seconds. The payer has to raise a payment and pass their own
            identity check before it reaches you.
          </EmptyState>
        </Panel>
      ) : (
        <div className="space-y-3">
          {payee.incoming.map((payment) => (
            <IncomingCard
              key={payment.paymentRequestId}
              payment={payment}
              flow={payee}
              vendorId={session?.vendorId ?? ""}
            />
          ))}
        </div>
      )}
    </>
  );
}
