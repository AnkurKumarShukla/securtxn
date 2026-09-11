// The end-to-end flow, as data.
//
// WHY A STEP LIST AND NOT A SCRIPT. The point of the console is to find where
// the flow breaks, so every step has to be individually runnable, individually
// inspectable, and has to record exactly what it sent and what came back. A
// single "run everything" function would collapse all of that into one stack
// trace.
//
// Nothing here mocks or shortcuts: each step calls the same endpoint a real
// client calls, in the same order the service layer enforces. If a gate is
// broken the console shows the 4xx, which is the whole idea.
//
// Spec: docs/payment-flow.md

// Empty means same-origin: Next proxies the API's path prefixes to the API
// process (see next.config.mjs), so the console works unchanged on localhost
// and through the public tunnel. `?? ""` rather than `|| ""` so an explicitly
// empty value is honoured instead of falling back to a host that is only
// correct on this machine.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export type StepState = "idle" | "running" | "ok" | "failed" | "skipped";

// `| undefined` on every optional: the project runs with
// exactOptionalPropertyTypes, so "present but undefined" and "absent" are
// different types, and this record is built by spreading partial results.
export type StepRecord = {
  state: StepState;
  request?: unknown;
  response?: unknown;
  status?: number | undefined;
  error?: string | undefined;
  note?: string | undefined;
  /** A URL the operator must act on before the step can finish (DigiLocker consent). */
  prompt?: string | undefined;
  ms?: number | undefined;
};

export type ApiCall = {
  status: number;
  ok: boolean;
  body: unknown;
};

/**
 * One fetch, with the body parsed either way.
 *
 * The error body is kept verbatim: during integration the exact message is the
 * entire diagnostic value, and collapsing it to "request failed" is what makes
 * a flow like this hard to debug.
 */
export async function api(
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<ApiCall> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  // The tunnel serves an interstitial to anything that looks like a browser.
  headers["ngrok-skip-browser-warning"] = "1";

  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text — a non-JSON body is itself the finding */
  }

  return { status: res.status, ok: res.ok, body };
}

/** Pulls the human-readable message out of the API's error envelope. */
export function messageOf(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err?.message) return err.message;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * What each party's World ID proof is bound to. Must match the API's
 * `senderSignal` / `payeeSignal` exactly, or the check is refused as "taken for
 * a different payment".
 *
 * Role-qualified rather than the bare payment id: the nullifier table is unique
 * on (nullifier, action, signal), so with one signal a single human acting as
 * both sides collides with themselves and the second proof reads as a replay.
 */
export const senderSignal = (paymentId: string) => `sender:${paymentId}`;
export const payeeSignal = (paymentId: string) => `payee:${paymentId}`;

export type StepId =
  | "token"
  | "payer"
  | "payerIdentity"
  | "senderEnrol"
  | "payeeReady"
  | "createPayment"
  | "senderWorldId"
  | "requestConsent"
  | "consentPrompt"
  | "awaitConsent"
  | "runDecision"
  | "propose"
  | "settle"
  | "escrow"
  | "evidence"
  | "anchor";

export type StepDef = {
  id: StepId;
  phase: "Setup" | "Onboarding" | "Payment" | "Settlement" | "Audit";
  label: string;
  /** What this step proves, in one line. Shown under the label. */
  proves: string;
  /** True when a human has to act in the browser (World ID). */
  manual?: boolean | undefined;
};

export const STEPS: StepDef[] = [
  { id: "token", phase: "Setup", label: "Mint agent token", proves: "the API is up and issuing role-scoped tokens" },

  { id: "payer", phase: "Onboarding", label: "O1 · Create payer vendor", proves: "the sending party exists as a record" },
  { id: "payerIdentity", phase: "Onboarding", label: "O2 · Payer DigiLocker", proves: "who the SENDER legally is — opens a real consent tab; PAN kept only as a digest", manual: true },
  { id: "senderEnrol", phase: "Onboarding", label: "O7 · Your World ID enrolment", proves: "stores YOUR nullifier — the value P2 compares against to prove the same human raised the payment", manual: true },
  { id: "payeeReady", phase: "Onboarding", label: "Check the payee is ready", proves: "the payee onboarded themselves at /payee — confirmed wallet, on-chain KYC" },

  { id: "createPayment", phase: "Payment", label: "P1 · Create payment", proves: "sender states the address + who they INTEND to pay" },
  { id: "senderWorldId", phase: "Payment", label: "P2 · Sender World ID", proves: "a live human raised this payment — required every time", manual: true },
  { id: "requestConsent", phase: "Payment", label: "P3 · Request payee consent", proves: "the payee is notified; blocked payers are refused here" },
  { id: "consentPrompt", phase: "Payment", label: "P3b · Read the consent prompt", proves: "what the payee is shown before deciding" },
  { id: "awaitConsent", phase: "Payment", label: "P4+P5 · Wait for the payee", proves: "they accept on their own page, signing with their own key — you cannot do it for them", manual: true },
  { id: "runDecision", phase: "Payment", label: "P6+P7 · CRE match + decision", proves: "the enclave compares digests; the chain's KYC gates the verdict" },
  { id: "propose", phase: "Payment", label: "P8 · Propose to approver", proves: "a human queue stands between the verdict and the money" },

  { id: "settle", phase: "Settlement", label: "P9 · Settle", proves: "money moves on Hedera — outright (DIRECT) or into the escrow contract (HTLC)" },
  { id: "escrow", phase: "Settlement", label: "P10 · Escrow state", proves: "HTLC only: the lock on chain, and whether the payee has claimed it" },

  { id: "evidence", phase: "Audit", label: "P12a · Read the evidence chain", proves: "every step above left a hash-linked record, in causal order" },
  { id: "anchor", phase: "Audit", label: "P12b · Anchor to HCS", proves: "a Merkle root on a public topic nobody can rewrite" },
];
