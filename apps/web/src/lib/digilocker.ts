// The DigiLocker consent wait, in one place.
//
// This loop existed twice — `runner.ts`'s `digilocker()` and the payee page's
// `onboard()` — with the same three-second interval, the same five-minute
// budget and the same terminal-status handling, which is exactly the kind of
// duplication that drifts.
//
// WHAT IS NOT EXTRACTED, DELIBERATELY. The two callers throw different
// messages on the same outcome, and rewording either would change what an
// operator reads when a consent times out. So this returns the terminal
// outcome and lets each caller phrase it, which keeps both behaviours byte for
// byte what they were.
//
// WHY POLL AT ALL rather than trust the redirect: the consent is a fact on
// DigiLocker's side, and a query parameter on a callback URL is not evidence
// of it.

import { api } from "./flow";

/** How often the session is re-read. */
export const CONSENT_POLL_MS = 3000;

/** How long a human gets to finish consenting before the step gives up. */
export const CONSENT_BUDGET_MS = 5 * 60_000;

export type ConsentOutcome = "succeeded" | "failed" | "expired" | "timeout";

/**
 * Waits for a DigiLocker session to reach a terminal state.
 *
 * Returns `"timeout"` rather than throwing on expiry: the caller owns the
 * message, and for the console the tab may genuinely still be open.
 *
 * A failed poll is ignored rather than fatal — the API restarting mid-consent
 * should not lose a consent the human already gave.
 */
export async function pollConsent(input: {
  vendorId: string;
  token: string | null;
  /**
   * Called once with the wall-clock deadline, so a caller can render a
   * countdown against the same budget this loop is enforcing.
   */
  onDeadline?: (deadline: number) => void;
}): Promise<ConsentOutcome> {
  const deadline = Date.now() + CONSENT_BUDGET_MS;
  input.onDeadline?.(deadline);

  let status = "created";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CONSENT_POLL_MS));

    const poll = await api(`/vendors/${input.vendorId}/identity/status`, { token: input.token });
    if (!poll.ok) continue;

    status = (poll.body as { status: string }).status;
    if (status === "succeeded") return "succeeded";
    if (status === "failed") return "failed";
    if (status === "expired") return "expired";
  }

  return "timeout";
}
