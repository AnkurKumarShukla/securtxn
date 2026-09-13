"use client";

// Where a party's key lives — on either side of a payment.
//
// SHARED, because both sides now hold an address and for the same reason. The
// payee is paid to theirs; the payer funds escrows from theirs, and the escrow
// contract refunds to whoever sent the lock. Neither address is a detail the
// platform can hold on someone's behalf without becoming the custodian this
// product exists to avoid being.
//
// It locks once a wallet is confirmed. Changing the address afterwards would
// leave a vendor verified for an account nobody can sign for — the same
// orphaning a cleared browser store used to cause.

import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Surface";
import { Hash } from "../ui/Mono";
import { StatusPill } from "../ui/StatusPill";

export function WalletCard({
  title,
  lead,
  mode,
  address,
  available,
  locked,
  connecting,
  switching,
  disabled,
  onConnect,
  /**
   * Absent for the payer, and deliberately.
   *
   * A generated key is a reasonable fallback for RECEIVING in a demo. It is not
   * a reasonable way to SEND real money: the payer's key signs transfers out of
   * a funded account, and one that lives in localStorage is one a cleared
   * browser destroys with the funds still in it.
   */
  onUseLocalKey,
  lockedNote,
}: {
  title: string;
  lead: string;
  mode: "local" | "metamask";
  address: string | null;
  available: boolean;
  locked: boolean;
  connecting: boolean;
  switching?: boolean;
  disabled?: boolean;
  onConnect: () => void;
  onUseLocalKey?: (() => void) | undefined;
  lockedNote: string;
}) {
  const isMetamask = mode === "metamask";
  const connected = isMetamask && Boolean(address);

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-mist-50">{title}</h2>
          <p className="mt-1 text-2xs leading-relaxed text-mist-400">{lead}</p>
        </div>
        {locked ? (
          <StatusPill tone="ok">confirmed</StatusPill>
        ) : connected ? (
          <StatusPill tone="ok">connected</StatusPill>
        ) : (
          <StatusPill tone="waiting">not set</StatusPill>
        )}
      </div>

      {address && (
        <div className="well mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
          <span className="font-mono text-micro tracking-micro text-mist-500 uppercase">
            {isMetamask ? "MetaMask" : "Generated here"}
          </span>
          <Hash value={address} chars={10} />
        </div>
      )}

      {locked ? (
        <p className="mt-3 text-2xs leading-relaxed text-mist-500">{lockedNote}</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant={connected ? "ghost" : "primary"}
              onClick={onConnect}
              disabled={!available || disabled}
              busy={connecting}
            >
              {connecting
                ? "Check MetaMask…"
                : connected
                  ? "Change account"
                  : "Connect MetaMask"}
            </Button>
            {onUseLocalKey && isMetamask && (
              <Button variant="quiet" onClick={onUseLocalKey} disabled={disabled} busy={switching}>
                Use a generated key instead
              </Button>
            )}
            {onUseLocalKey && !isMetamask && available && (
              <span className="self-center text-2xs text-mist-500">
                Currently signing with a key generated in this browser.
              </span>
            )}
          </div>

          {!available && (
            <Alert tone="warn" className="mt-3" title="No wallet extension found">
              {onUseLocalKey
                ? "Install MetaMask and reload this page to connect a real account. Until then this onboarding will sign with a key generated in this browser."
                : "Install MetaMask and reload this page. Payments are funded from your own wallet, so there is no way to continue without one."}
            </Alert>
          )}

          {onUseLocalKey && !isMetamask && (
            <Alert tone="warn" className="mt-3" title="This key only exists in this browser">
              Clearing site data or opening this page in a private window destroys it, and the
              onboarding it belongs to cannot be recovered — including any DigiLocker consent you
              have already given. Connect MetaMask to avoid that.
            </Alert>
          )}

          {isMetamask && !connected && (
            <p className="mt-3 text-2xs leading-relaxed text-mist-500">
              Your wallet will be switched to Hedera testnet, and added to MetaMask first if it is
              not there yet.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
