// The step implementations.
//
// Kept out of the component so each step is a plain async function over a
// mutable run context: readable top to bottom, and the page stays about
// rendering. Every function calls a real endpoint — nothing here simulates a
// result, because a console that fakes a step cannot tell you the step is broken.

import { IDENTITY_BINDING_TYPES, WALLET_CONTROL_TYPES, domainFor, CONTROL_STATEMENT } from "@cp/shared-types";

import { api, messageOf, type ApiCall, type StepId } from "./flow";

/** Everything the run accumulates. Shown in the sidebar so nothing is hidden. */
export type RunContext = {
  chainId: number;
  token: string | null;
  payerVendorId: string | null;
  payeeVendorId: string | null;
  walletId: string | null;
  controlProofNonce: string | null;
  paymentId: string | null;
  invoiceRef: string | null;
  amount: string;
  /** The asset symbol. Named `asset` because `token` is already the bearer token. */
  asset: string;
  /**
   * DIRECT sends the money outright. HTLC locks it in the escrow contract
   * against a hash, and the payee only gets it by revealing the preimage —
   * which means an unclaimed payment refunds instead of sitting with the wrong
   * party. Chosen per payment, at P1, because the approver approves the mode
   * too (D41).
   */
  settlementMode: "DIRECT" | "HTLC";
  /**
   * Taken from the payee's CONFIRMED wallet, never hardcoded.
   *
   * A payment's network must equal its wallet's, and the console used to send
   * "ethereum" regardless — which happened to match only because the payee
   * registered there. Reading it removes a guess that would fail the moment a
   * payee onboarded on a different network.
   */
  network: string;
  /**
   * The payee's address, read from THEIR vendor record. The sender never holds
   * the payee's key — that is the point of the split: consent has to be signed
   * by the party being paid.
   */
  payeeAddress: string;
  /** Set when the sender/payee World ID steps complete. */
  senderWorldIdId: string | null;
  /**
   * Kept apart from the enrolment id ON PURPOSE. Consent must carry a
   * REVERIFICATION bound to this payment; sending the enrolment id instead is
   * refused ("an enrolment cannot stand in for a payment-time check"), and one
   * shared field would silently do exactly that.
   */
  payeeWorldIdId: string | null;
  payeeEnrolmentId: string | null;
  /**
   * The sender enrols too. A REVERIFICATION is checked against the subject's
   * ENROLLMENT, so without this P2 fails with "not enrolled" rather than
   * anything about the payment.
   */
  senderEnrolmentId: string | null;
  /** What the sender CLAIMS about the payee — the whole point of the match. */
  claimedName: string;
  claimedPan: string;
};

export function freshContext(chainId: number): RunContext {
  return {
    chainId,
    token: null,
    payerVendorId: null,
    payeeVendorId: null,
    walletId: null,
    controlProofNonce: null,
    paymentId: null,
    invoiceRef: null,
    amount: "10.00",
    asset: "stUSDC",
    settlementMode: "DIRECT",
    network: "ethereum",
    payeeAddress: "",
    senderWorldIdId: null,
    payeeWorldIdId: null,
    payeeEnrolmentId: null,
    senderEnrolmentId: null,
    claimedName: "Meridian Components Private Limited",
    claimedPan: "ABCDE1234F",
  };
}

export class StepError extends Error {
  constructor(
    message: string,
    readonly call?: ApiCall,
  ) {
    super(message);
  }
}

function must(call: ApiCall, what: string): ApiCall {
  if (!call.ok) throw new StepError(`${what} → ${call.status}: ${messageOf(call.body)}`, call);
  return call;
}

export type StepResult = { request?: unknown; response: unknown; status?: number; note?: string };

/**
 * `report` pushes a partial update WHILE a step is still running.
 *
 * The DigiLocker steps need it: the consent URL has to reach the operator
 * before the step finishes, because the step does not finish until a human has
 * used that URL. Returning it at the end would be too late to be useful.
 */
export type Report = (patch: { note?: string; prompt?: string }) => void;

type Runner = (ctx: RunContext, report: Report) => Promise<StepResult>;

/**
 * Real DigiLocker, for one vendor.
 *
 * The consent step CANNOT be automated, and that is the point — it is what
 * makes DigiLocker defensible as an identity source. So this opens the
 * authorization URL in a new tab, then polls the session until the human has
 * finished. It never fabricates a consent.
 *
 * Each person consents with their own DigiLocker account, so unlike the
 * recorded fixture there is no single shared identity and both sides can
 * onboard.
 */
async function digilocker(
  ctx: RunContext,
  vendorId: string,
  report: Report,
  who: "sender" | "payee",
): Promise<unknown> {
  const session = must(
    await api(`/vendors/${vendorId}/identity/session`, {
      method: "POST",
      token: ctx.token,
      body: { docTypes: ["aadhaar", "pan"] },
    }),
    "identity/session",
  ).body as { sessionId: string; authorizationUrl: string };

  report({
    prompt: session.authorizationUrl,
    note:
      who === "payee"
        ? "Send this link to the PAYEE. They consent with their own DigiLocker account — a second vendor cannot reuse yours."
        : "Consent with your own DigiLocker account in the tab that opened.",
  });

  // Opened for the sender, who is at this browser. The payee is usually not,
  // so their link is shown to be sent rather than assumed to be clicked here.
  if (who === "sender" && typeof window !== "undefined") {
    window.open(session.authorizationUrl, "_blank", "noopener");
  }

  // Poll rather than trusting the redirect: the consent is a fact on
  // DigiLocker's side, and a query parameter on a callback URL is not evidence
  // of it.
  const deadline = Date.now() + 5 * 60_000;
  let status = "created";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await api(`/vendors/${vendorId}/identity/status`, { token: ctx.token });
    if (!poll.ok) continue;
    status = (poll.body as { status: string }).status;
    if (status === "succeeded") break;
    if (status === "failed" || status === "expired") {
      throw new StepError(`DigiLocker session ${status} — start the identity step again`);
    }
  }
  if (status !== "succeeded") {
    throw new StepError(
      "timed out after 5 minutes waiting for DigiLocker consent — the tab may still be open",
    );
  }

  const complete = await api(`/vendors/${vendorId}/identity/complete`, {
    method: "POST",
    token: ctx.token,
  });
  if (complete.ok) return complete.body;

  // A 409 here means this DigiLocker identity is still linked to an earlier,
  // ABANDONED attempt of your own — one vendor per identity is the rule that
  // stops a single human minting many payees, and it is doing its job.
  //
  // Releasing only unfinished attempts (no CONFIRMED wallet) and retrying once
  // clears your own debris without touching a counterparty who has finished.
  if (complete.status === 409) {
    const released = await api("/dev/identity/release", {
      method: "POST",
      token: ctx.token,
      body: { force: false },
    });
    if (released.ok) {
      const freed = (released.body as { released: number }).released;
      report({ note: `released ${freed} abandoned onboarding attempt(s); retrying` });

      const retry = await api(`/vendors/${vendorId}/identity/complete`, {
        method: "POST",
        token: ctx.token,
      });
      if (retry.ok) return retry.body;

      throw new StepError(
        `identity/complete → ${retry.status}: ${messageOf(retry.body)}. ` +
          "The identity is held by a vendor that finished onboarding — if that is stale too, " +
          "release it with force.",
      );
    }
  }

  throw new StepError(`identity/complete → ${complete.status}: ${messageOf(complete.body)}`);
}

export const RUNNERS: Record<StepId, Runner> = {
  async token(ctx) {
    const call = must(
      await api("/dev/token", {
        method: "POST",
        body: { role: "agent", subject: "flow-console" },
      }),
      "dev/token",
    );
    ctx.token = (call.body as { token: string }).token;
    return { response: { role: "agent", token: `${ctx.token.slice(0, 24)}…` } };
  },

  async payer(ctx) {
    const call = must(
      await api("/vendors", {
        method: "POST",
        token: ctx.token,
        body: { payeeType: "BUSINESS", legalEntityName: "Northwind Buyers Pvt Ltd", country: "IN" },
      }),
      "create payer",
    );
    ctx.payerVendorId = (call.body as { id: string }).id;
    return { response: call.body };
  },

  async payerIdentity(ctx, report) {
    const body = await digilocker(ctx, ctx.payerVendorId!, report, "sender");
    return { response: body, note: "The SENDER consented with their own DigiLocker account." };
  },

  /**
   * O7 for the SENDER.
   *
   * A REVERIFICATION is only meaningful against an ENROLLMENT: the service
   * compares the new proof's nullifier to the one stored for this subject, and
   * with nothing stored it fails closed with "not enrolled". So this has to
   * happen before P2, and it has to be a step rather than a panel someone might
   * not notice — the failure it prevents surfaces two steps later and says
   * nothing about enrolment.
   */
  async senderEnrol(ctx) {
    if (!ctx.senderEnrolmentId) {
      throw new StepError(
        "open “1 · Your enrolment (O7)” in the sidebar and complete a real Selfie Check. " +
          "It stores your nullifier; P2 proves the same human by comparing against it.",
      );
    }
    return {
      response: { verificationId: ctx.senderEnrolmentId },
      note: "Your nullifier is stored. P2 will compare this payment's check against it.",
    };
  },

  /**
   * The payee onboards THEMSELVES, at /payee, with their own DigiLocker
   * account and their own key. This step only confirms they finished.
   *
   * It is not a formality: a payment to a wallet that is not CONFIRMED, or to
   * an address the token will not accept, fails later and further from the
   * cause. Checking here names the problem while it is still fixable.
   */
  async payeeReady(ctx) {
    if (!ctx.payeeVendorId) {
      throw new StepError(
        "paste the payee's vendor id in the sidebar — they get it from /payee after onboarding",
      );
    }

    const wallets = must(
      await api(`/vendors/${ctx.payeeVendorId}/wallets`, { token: ctx.token }),
      "list payee wallets",
    ).body as { walletId?: string; id?: string; address: string; status: string; network: string }[];

    const confirmed = wallets.find((w) => w.status === "CONFIRMED");
    if (!confirmed) {
      throw new StepError(
        `the payee has no CONFIRMED wallet yet (${wallets.length} registered). They finish at /payee.`,
      );
    }

    ctx.walletId = confirmed.walletId ?? confirmed.id ?? null;
    ctx.payeeAddress = confirmed.address;
    ctx.network = confirmed.network;

    return {
      response: {
        walletId: ctx.walletId,
        address: confirmed.address,
        status: confirmed.status,
        network: confirmed.network,
      },
      note: "Payee is onboarded. You never see their PAN or name — only digests the enclave compares.",
    };
  },

  async createPayment(ctx) {
    ctx.invoiceRef = `INV-CONSOLE-${Date.now()}`;
    const body = {
      vendorId: ctx.payeeVendorId,
      vendorWalletId: ctx.walletId,
      payerVendorId: ctx.payerVendorId,
      intendedPayeeName: ctx.claimedName,
      intendedPayeePan: ctx.claimedPan,
      invoiceRef: ctx.invoiceRef,
      amount: ctx.amount,
      token: ctx.asset,
      network: ctx.network,
      settlementMode: ctx.settlementMode,
    };
    const call = must(await api("/payments", { method: "POST", token: ctx.token, body }), "create payment");
    ctx.paymentId = (call.body as { id: string }).id;
    return { request: body, response: call.body };
  },

  async senderWorldId(ctx) {
    if (!ctx.senderWorldIdId) {
      throw new StepError("run the sender World ID widget above — signal must be the payment id");
    }
    return { response: { verificationId: ctx.senderWorldIdId } };
  },

  async requestConsent(ctx) {
    const call = must(
      await api(`/payments/${ctx.paymentId}/request-consent`, { method: "POST", token: ctx.token }),
      "request-consent",
    );
    return {
      response: call.body,
      note: "Refused here if the payer is blocked, or if the sender has no World ID check for this payment.",
    };
  },

  async consentPrompt(ctx) {
    const call = await api(`/payments/${ctx.paymentId}/consent-prompt`, { token: ctx.token });
    if (call.ok) {
      return {
        response: call.body,
        note: "What the payee sees. Their name is resolved at read time, never stored in the notification.",
      };
    }

    // The prompt only exists while the payment is AWAITING_PAYEE_CONSENT. A
    // payee who accepts quickly closes that window, and this step is a look at
    // what they saw — not a gate. Failing the run for it would report a race as
    // a defect.
    if (call.status === 409) {
      return {
        response: call.body,
        note: "The payee already answered — the prompt is gone. Nothing is wrong; this step only shows what they were asked.",
      };
    }
    throw new StepError(`consent-prompt → ${call.status}: ${messageOf(call.body)}`);
  },

  /**
   * P4 and P5 happen on the PAYEE's page, not here.
   *
   * This step waits for them. The sender cannot sign the payee's consent —
   * that is the entire control: the acceptance has to come from the key the
   * money is going to, held by the party being paid.
   */
  async awaitConsent(ctx) {
    const payment = must(
      await api(`/payments/${ctx.paymentId}`, { token: ctx.token }),
      "read payment",
    ).body as { status: string };

    if (payment.status === "DECISION_PENDING") {
      return {
        response: { status: payment.status },
        note: "The payee accepted, signing with their payout key. The match may now run.",
      };
    }
    if (payment.status === "EXCEPTION") {
      throw new StepError("the payee DENIED this payment — it stops here, and no match ran");
    }

    throw new StepError(
      `still '${payment.status}'. The payee accepts at /payee — send them that link. ` +
        "This step succeeds once they have.",
    );
  },

  async runDecision(ctx) {
    const call = must(
      await api(`/payments/${ctx.paymentId}/run-decision`, { method: "POST", token: ctx.token }),
      "run-decision",
    );
    return {
      response: call.body,
      note: "The verdict came from the CRE enclave when VENDOR_MATCHER=cre.",
    };
  },

  async propose(ctx) {
    const call = must(
      await api(`/payments/${ctx.paymentId}/propose`, { method: "POST", token: ctx.token, body: {} }),
      "propose",
    );
    return { response: call.body };
  },

  async settle(ctx) {
    const approver = must(
      await api("/dev/token", { method: "POST", body: { role: "approver", subject: "flow-console" } }),
      "approver token",
    ).body as { token: string };

    const call = must(
      await api(`/payments/${ctx.paymentId}/settle`, {
        method: "POST",
        token: approver.token,
        body: {},
      }),
      "settle",
    );

    const body = call.body as {
      mode: string;
      txHash: string;
      settlement?: { escrowAddress: string; lockId: string; timelock: string } | null;
    };

    return {
      response: call.body,
      note:
        body.mode === "HTLC"
          ? `Locked in escrow ${body.settlement?.escrowAddress}. The payee collects by revealing the preimage; unclaimed, it refunds after ${body.settlement?.timelock}.`
          : "Approver-scoped: an agent token cannot move money. Sent outright — there is no undo.",
    };
  },

  /**
   * The escrow, read off chain state rather than our own record.
   *
   * For a DIRECT payment there is nothing to show and that is not a failure —
   * the mode was chosen at P1 and this step reports what that choice produced.
   */
  async escrow(ctx) {
    const call = await api(`/payments/${ctx.paymentId}/settlement`, { token: ctx.token });

    if (call.status === 404) {
      return {
        response: { mode: "DIRECT" },
        note: "No escrow: this payment settled DIRECT. Choose HTLC at P1 to use the contract.",
      };
    }
    if (!call.ok) throw new StepError(`settlement → ${call.status}: ${messageOf(call.body)}`);

    const s = call.body as {
      status: string;
      escrowAddress: string;
      lockId: string;
      hashlock: string;
      timelock: string;
      claimTxHash: string | null;
      refundTxHash: string | null;
    };

    return {
      response: call.body,
      note:
        s.status === "CLAIMED"
          ? `Claimed — the payee revealed the preimage, which IS the receipt (tx ${s.claimTxHash}).`
          : s.status === "REFUNDED"
            ? `Refunded — nobody claimed before ${s.timelock}, so the money came back (tx ${s.refundTxHash}).`
            : `Locked at ${s.escrowAddress}. The payee claims with the preimage; unclaimed it refunds after ${s.timelock}.`,
    };
  },

  async evidence(ctx) {
    const call = must(
      await api(`/payments/${ctx.paymentId}/evidence`, { token: ctx.token }),
      "evidence",
    );
    const chain = call.body as { records: { eventType: string }[]; chainValid: boolean };
    return {
      response: call.body,
      note: `${chain.records?.length ?? 0} records, chainValid=${chain.chainValid}: ${chain.records
        ?.map((r) => r.eventType)
        .join(" → ")}`,
    };
  },

  async anchor(ctx) {
    const call = must(
      await api("/evidence/anchor", { method: "POST", token: ctx.token, body: {} }),
      "anchor",
    );
    return { response: call.body, note: "A Merkle root on the HCS topic when ANCHOR_GATEWAY=hcs." };
  },
};

function withPrefix(hash: string): `0x${string}` {
  return (hash.startsWith("0x") ? hash : `0x${hash}`) as `0x${string}`;
}
