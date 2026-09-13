"use client";

// What this wallet actually holds, on chain.
//
// TWO BALANCES, BOTH LOAD-BEARING, and they fail in different ways:
//
//   HBAR   pays gas. Without it every signature succeeds and every transaction
//          fails, which reads as the app being broken rather than the account
//          being empty.
//   token  the thing being paid. The payer funds escrows from their own
//          balance now, so a short one stops a payment at the point of
//          funding — after the approval, and after the payee has consented.
//
// THE THIRD LINE IS THE ONE PEOPLE DO NOT EXPECT. A Hedera account only
// receives an HTS token it is associated with. An address that has never
// transacted is not an account at all yet, so there is nothing to associate;
// completing it sets unlimited auto-association and the problem disappears.
// Until then a transfer TO this address reverts, and nothing on either side
// says why. Better to say it here, before anyone tries.

import { useCallback, useEffect, useState } from "react";
import { useApp } from "./AppProvider";
import { api } from "../../lib/flow";
import { Panel } from "../ui/Surface";
import { Button } from "../ui/Button";
import { Alert } from "../ui/Alert";
import { StatusPill } from "../ui/StatusPill";

type AccountView = {
  evmAddress: string;
  hederaId: string | null;
  hbar: string | null;
  maxAutoAssociations: number | null;
  tokenBalance: string | null;
};

const ASSET = "stUSDC";

export function BalanceCard({ address }: { address: string }) {
  const { token, ready } = useApp();
  const [view, setView] = useState<AccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await token();
      const res = await api(
        `/dev/treasury?asset=${encodeURIComponent(ASSET)}&payee=${address}`,
        { token: t },
      );
      if (!res.ok) throw new Error("could not read balances");
      setView((res.body as { payee: AccountView | null }).payee);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [token, address]);

  useEffect(() => {
    if (ready && address) void load();
  }, [ready, address, load]);

  // An address with no Hedera account answers neither balance. That is a
  // different fact from "zero", and showing 0 would be a lie that hides the
  // actual problem.
  const noAccount = view !== null && view.hederaId === null;

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-mono text-micro tracking-wide text-mist-500 uppercase">Balances</h2>
        <Button size="sm" variant="quiet" onClick={() => void load()} busy={busy}>
          Refresh
        </Button>
      </div>

      {error && (
        <Alert tone="warn" className="mb-3">
          {error}
        </Alert>
      )}

      <div className="space-y-px overflow-hidden rounded-md">
        <Row label="HBAR" hint="pays gas" value={view?.hbar} />
        <Row label={ASSET} hint="the asset paid" value={view?.tokenBalance} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-micro tracking-micro text-mist-500 uppercase">
          Hedera account
        </span>
        {view === null ? (
          <span className="text-2xs text-mist-600">—</span>
        ) : noAccount ? (
          <StatusPill tone="waiting">not created yet</StatusPill>
        ) : (
          <span className="font-mono text-2xs text-mist-300">{view.hederaId}</span>
        )}
      </div>

      {noAccount && (
        <Alert tone="warn" className="mt-3" title="This address is not a Hedera account yet">
          Send it some testnet HBAR, or make one transaction from it. Until then it cannot receive
          the token and a payment to it reverts with nothing explaining why.
        </Alert>
      )}

      {view?.maxAutoAssociations === 0 && (
        <Alert tone="warn" className="mt-3" title="No auto-association slots">
          This account has to associate {ASSET} before it can receive any. An account completed by
          its own first transaction gets unlimited slots instead.
        </Alert>
      )}
    </Panel>
  );
}

function Row({ label, hint, value }: { label: string; hint: string; value: string | null | undefined }) {
  return (
    <div className="well flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2.5">
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-mist-100">{label}</span>
        <span className="text-2xs text-mist-600">{hint}</span>
      </span>
      <span data-numeric className="text-base text-mist-50">
        {value ?? "—"}
      </span>
    </div>
  );
}
