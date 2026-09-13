"use client";

// Money locked for you, and collecting it.
//
// THE REVEAL IS THE RECEIPT. The escrow pays out to whoever presents the
// secret, so the claim has to come from your own key — a platform that could
// claim on your behalf would only be proving it can move its own money.
//
// And if you never claim, the funds return to the payer when the clock runs
// out. That is the recovery property: it needs no cooperation from anybody.

import { useApp } from "../../../components/app/AppProvider";
import { PageHeader } from "../../../components/app/shell/Page";
import { EscrowCard } from "../../../components/app/payee/EscrowCard";
import { Alert } from "../../../components/ui/Alert";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Panel } from "../../../components/ui/Surface";

export default function EscrowPage() {
  const { payee } = useApp();

  return (
    <>
      <PageHeader
        title="Escrow"
        lead="Funds held against a secret only you can reveal. Unclaimed, they return to the payer after the timelock."
      />

      {payee.error && (
        <Alert tone="error" className="mb-4">
          {payee.error}
        </Alert>
      )}

      {payee.escrows.length === 0 ? (
        <Panel className="p-6">
          <EmptyState title="Nothing locked">
            When a payer settles through the escrow rather than sending outright, it appears here
            and is yours only once you claim it.
          </EmptyState>
        </Panel>
      ) : (
        <div className="space-y-3">
          {payee.escrows.map((escrow) => (
            <EscrowCard key={escrow.paymentRequestId} escrow={escrow} flow={payee} />
          ))}
        </div>
      )}
    </>
  );
}
