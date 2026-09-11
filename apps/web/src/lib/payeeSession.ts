// The payee's own state, kept in their browser.
//
// WHY IT PERSISTS. The payee signs twice, minutes or hours apart: once to prove
// they control the payout address (O4/O5), and again to accept a payment that
// does not exist yet (P4). A key regenerated on reload would orphan the
// onboarding — the wallet would be CONFIRMED for an address nobody can sign
// for any more, and the DigiLocker consent already paid for would be wasted.
//
// localStorage, not a cookie and not the server: this key stands in for the
// payee's wallet, and a payout key that the platform holds is not a payout key
// the payee controls. Clearing site data loses it, which is the correct
// trade-off for a test harness — and the UI says so.

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const KEY = "confirmed-payee.session.v1";

export type PayeeSession = {
  privateKey: `0x${string}`;
  vendorId: string | null;
  walletId: string | null;
  /** Set once O7 completes, so P5 has something to prove continuity against. */
  enrolmentId: string | null;
};

function empty(): PayeeSession {
  return { privateKey: generatePrivateKey(), vendorId: null, walletId: null, enrolmentId: null };
}

/**
 * Reads the stored session, creating one on first use.
 *
 * Never called during render — a fresh key differs between the server and the
 * client, and React discards the tree on that mismatch.
 */
export function loadSession(): PayeeSession {
  if (typeof window === "undefined") return empty();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PayeeSession;
      if (parsed?.privateKey?.startsWith("0x")) return parsed;
    }
  } catch {
    // Corrupt or unreadable storage is not worth failing over; a new session
    // is the same position as a first visit.
  }
  const created = empty();
  saveSession(created);
  return created;
}

export function saveSession(session: PayeeSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* private mode, or storage full — the run still works, it just will not resume */
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

export function accountOf(session: PayeeSession): PrivateKeyAccount {
  return privateKeyToAccount(session.privateKey);
}
