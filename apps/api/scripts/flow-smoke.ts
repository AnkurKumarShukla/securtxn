// The whole flow, headless, against a running API.
//
// The console at /console drives these same endpoints from a browser. This
// drives them from a terminal, which makes it repeatable, CI-able, and usable
// as the reset between demo takes.
//
// WHAT IT CANNOT DO: the two World ID checks need a real Selfie Check from the
// World app. Where a check is required this script reports the refusal it got
// and stops — it does not insert a verification row to get past the gate. A
// smoke test that forged the thing under test would be worse than none.
//
//   pnpm --filter @cp/api flow:smoke
//
// Spec: docs/payment-flow.md

import {
  IDENTITY_BINDING_TYPES,
  PAYEE_CONSENT_TYPES,
  WALLET_CONTROL_TYPES,
  CONTROL_STATEMENT,
  PAYEE_CONSENT_STATEMENT,
  domainFor,
} from "@cp/shared-types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config/index.js";

const config = loadConfig();
const BASE = process.env.SMOKE_API_BASE ?? "http://127.0.0.1:3000";
const CHAIN_ID = config.EIP712_CHAIN_ID;

const payee = privateKeyToAccount(generatePrivateKey());

let token = "";
let step = 0;
let stopped = false;

type Call = { status: number; ok: boolean; body: any };

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<Call> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const bearer = init.token ?? token;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  // Without this, ngrok answers a non-browser request with its interstitial
  // HTML at status 200 — so the call "succeeds", the body is not JSON, and the
  // failure only surfaces later as `undefined` in a URL.
  headers["ngrok-skip-browser-warning"] = "1";

  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is itself the finding */
  }
  return { status: res.status, ok: res.ok, body: body as any };
}

function messageOf(body: any): string {
  return body?.error?.message ?? (typeof body === "string" ? body : JSON.stringify(body));
}

/** Runs one step, printing a single line. Returns null once anything has failed. */
async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (stopped) return null;
  step += 1;
  const started = Date.now();
  try {
    const value = await fn();
    console.log(`  ${String(step).padStart(2)}. ✓ ${label}  ${Date.now() - started}ms`);
    return value;
  } catch (error) {
    console.log(`  ${String(step).padStart(2)}. ✗ ${label}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
    stopped = true;
    return null;
  }
}

function must(result: Call, what: string): Call {
  if (!result.ok) throw new Error(`${what} → ${result.status}: ${messageOf(result.body)}`);
  // A 200 carrying HTML is how a tunnel interstitial or a proxy error page
  // arrives. Catching it here names the real problem instead of letting an
  // `undefined` id travel three steps and fail as "Invalid uuid".
  if (typeof result.body === "string") {
    throw new Error(
      `${what} → ${result.status} but the body was not JSON: ${result.body.slice(0, 120)}`,
    );
  }
  return result;
}

async function digilocker(vendorId: string): Promise<void> {
  const session = must(
    await call(`/vendors/${vendorId}/identity/session`, {
      method: "POST",
      body: { docTypes: ["aadhaar", "pan"] },
    }),
    "identity/session",
  );
  // Deliberately NOT `must`: this endpoint stands in for the human consent
  // screen and answers with HTML, so the not-JSON guard would flag the one
  // response in the flow that is supposed to be a page.
  const consent = await call(`/dev/identity/consent?session_id=${session.body.sessionId}`);
  if (!consent.ok) throw new Error(`dev consent → ${consent.status}: ${messageOf(consent.body)}`);
  must(await call(`/vendors/${vendorId}/identity/complete`, { method: "POST" }), "identity/complete");
}

console.log(`\nflow smoke — ${BASE}`);
console.log(`payee key   — ${payee.address} (burner, generated for this run)\n`);

await run("mint an agent token", async () => {
  const res = must(
    await call("/dev/token", { method: "POST", body: { role: "agent", subject: "flow-smoke" } }),
    "dev/token",
  );
  token = res.body.token;
});

const payerId = await run("O1 · create the payer", async () => {
  const res = must(
    await call("/vendors", {
      method: "POST",
      body: { payeeType: "BUSINESS", legalEntityName: "Northwind Buyers Pvt Ltd", country: "IN" },
    }),
    "create payer",
  );
  return res.body.id as string;
});

// DELIBERATELY SKIPPED, and this is a known limitation, not an oversight.
//
// The recorded DigiLocker fixture holds ONE identity and the API refuses to
// attach it to a second vendor (correctly — that check is what stops two
// vendors claiming the same person). So payer and payee cannot both complete
// O2 against it, and the payee is the one whose identity the match compares.
//
// Nothing in the code gates on the payer's tier — it is only displayed on the
// consent prompt — so the flow below is unaffected. The payee simply sees
// TIER0_UNVERIFIED as the party asking them for money, which is weaker than
// the intended demo.
//
// The real fix is the synthetic fixture tier (fixtures/digilocker-synthetic/,
// still empty): a second fake identity would let both sides verify.
console.log("     — · O2 payer DigiLocker SKIPPED: one fixture identity, see the note in this file");

const payeeId = await run("O1 · create the payee", async () => {
  const res = must(
    await call("/vendors", {
      method: "POST",
      body: {
        payeeType: "BUSINESS",
        legalEntityName: "Meridian Components Private Limited",
        country: "IN",
      },
    }),
    "create payee",
  );
  return res.body.id as string;
});

await run("O2 · payee DigiLocker", async () => {
  // Reclaim the single fixture identity from whichever vendor holds it — an
  // earlier run's payee, or a test. Without this every run after the first
  // gets a 409, which is the API correctly refusing to let two vendors claim
  // the same person.
  const released = must(await call("/dev/identity/release", { method: "POST" }), "release identity");
  if (released.body.released > 0) {
    console.log(`      reclaimed the fixture identity from ${released.body.released} vendor(s)`);
  }
  await digilocker(payeeId!);
});

// The nonce is returned ONCE, by the registration call. It is not on the
// wallet list — deliberately, since it is a challenge, not a property.
let controlProofNonce = "";

const walletId = await run("O3 · register the payout wallet", async () => {
  const res = must(
    await call(`/vendors/${payeeId}/wallets`, {
      method: "POST",
      body: { address: payee.address, network: "ethereum" },
    }),
    "register wallet",
  );
  controlProofNonce = res.body.controlProofNonce;
  if (!controlProofNonce) {
    throw new Error(`no controlProofNonce in the response: ${JSON.stringify(res.body)}`);
  }
  return res.body.walletId as string;
});

await run("O4 · control proof", async () => {
  const signature = await payee.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: WALLET_CONTROL_TYPES,
    primaryType: "WalletControlProof",
    message: {
      vendorId: payeeId!,
      walletAddress: payee.address,
      network: "ethereum",
      nonce: controlProofNonce as `0x${string}`,
      statement: CONTROL_STATEMENT,
    },
  });
  must(
    await call(`/vendors/${payeeId}/wallets/${walletId}/control-proof`, {
      method: "POST",
      body: { signature },
    }),
    "control-proof",
  );
});

await run("O5 · identity binding", async () => {
  const prepared = must(
    await call(`/vendors/${payeeId}/wallets/${walletId}/identity-binding-message`),
    "identity-binding-message",
  ).body;

  const signature = await payee.signTypedData({
    domain: prepared.domain,
    types: IDENTITY_BINDING_TYPES,
    primaryType: "IdentityBinding",
    message: prepared.message,
  });
  must(
    await call(`/vendors/${payeeId}/wallets/${walletId}/identity-binding`, {
      method: "POST",
      body: { signature },
    }),
    "identity-binding",
  );
});

await run("O6 · callback confirm", async () => {
  // The operator is TOLD which number to dial; they never choose it. That is
  // the whole control: an attacker who can pick the channel can confirm their
  // own wallet.
  const channels = must(
    await call(`/vendors/${payeeId}/wallets/${walletId}/callback-channels`),
    "callback-channels",
  ).body.channels;
  const channelUsed = channels[0]?.value;
  if (!channelUsed) {
    throw new Error("no independent contact on file — nothing may confirm this wallet");
  }
  console.log(`      dialling ${channels[0].source}`);
  must(
    await call(`/vendors/${payeeId}/wallets/${walletId}/callback-confirm`, {
      method: "POST",
      body: { confirmedBy: "flow-smoke", channelUsed },
    }),
    "callback-confirm",
  );
});

await run("O8 · grant KYC on chain", async () => {
  const res = must(
    await call(`/vendors/${payeeId}/wallets/${walletId}/grant-kyc`, { method: "POST", body: {} }),
    "grant-kyc",
  );
  console.log(`      ${JSON.stringify(res.body)}`);
});

const paymentId = await run("P1 · create the payment", async () => {
  const res = must(
    await call("/payments", {
      method: "POST",
      body: {
        vendorId: payeeId,
        vendorWalletId: walletId,
        payerVendorId: payerId,
        intendedPayeeName: "Meridian Components Private Limited",
        intendedPayeePan: "ABCDE1234F",
        invoiceRef: `INV-SMOKE-${Date.now()}`,
        amount: "1250.50",
        token: "USDC",
        network: "ethereum",
      },
    }),
    "create payment",
  );
  return res.body.id as string;
});

await run("P3 · request payee consent", async () => {
  const res = await call(`/payments/${paymentId}/request-consent`, { method: "POST" });
  if (!res.ok) {
    throw new Error(
      `${res.status}: ${messageOf(res.body)}\n` +
        "      ^ expected when World ID is on: P2 requires a real Selfie Check from the\n" +
        "        sender, bound to this payment. Use /console to supply it.",
    );
  }
  console.log(`      challenge: ${JSON.stringify(res.body.challengeTriggers ?? [])}`);
});

await run("P4 · payee accepts", async () => {
  const prompt = must(await call(`/payments/${paymentId}/consent-prompt`), "consent-prompt").body;
  const signature = await payee.signTypedData({
    domain: domainFor(CHAIN_ID),
    types: PAYEE_CONSENT_TYPES,
    primaryType: "PayeeConsent",
    message: {
      paymentRequestId: paymentId!,
      payeeAddress: prompt.payeeAddress,
      amount: prompt.amount,
      token: prompt.token,
      invoiceRef: prompt.invoiceRef,
      statement: PAYEE_CONSENT_STATEMENT,
    },
  });
  // No bearer token: the signature is the authorisation.
  const res = await fetch(`${BASE}/payments/${paymentId}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "ACCEPTED", signature, signerAddress: payee.address }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${messageOf(await res.json())}`);
});

await run("P6+P7 · CRE match and decision", async () => {
  const res = must(await call(`/payments/${paymentId}/run-decision`, { method: "POST" }), "run-decision");
  console.log(`      ${res.body.decision} / ${res.body.reasonCode}`);
});

await run("P8 · propose", async () => {
  must(await call(`/payments/${paymentId}/propose`, { method: "POST", body: {} }), "propose");
});

await run("P9 · settle", async () => {
  const approver = must(
    await call("/dev/token", { method: "POST", body: { role: "approver", subject: "flow-smoke" } }),
    "approver token",
  ).body;
  const res = must(
    await call(`/payments/${paymentId}/settle`, { method: "POST", body: {}, token: approver.token }),
    "settle",
  );
  console.log(`      tx ${res.body.txHash} broadcast=${res.body.broadcast}`);
});

await run("P12a · read the evidence chain", async () => {
  const res = must(await call(`/payments/${paymentId}/evidence`), "evidence").body;
  console.log(
    `      ${res.records.length} records, chainValid=${res.chainValid}: ` +
      res.records.map((r: any) => r.eventType).join(" → "),
  );
});

await run("P12b · anchor to HCS", async () => {
  const res = must(await call("/evidence/anchor", { method: "POST", body: {} }), "anchor");
  console.log(`      ${JSON.stringify(res.body)}`);
});

console.log(
  stopped
    ? "\nstopped — the first ✗ above is the cause\n"
    : "\nthe whole flow completed\n",
);
process.exit(stopped ? 1 : 0);
