"use client";

// Turning an address into one the token will accept.
//
// FOUR GATES, AND EVERY ONE OF THEM PROVES SOMETHING DIFFERENT. A wallet is
// only CONFIRMED when all four are in place, and only a CONFIRMED wallet may be
// granted on-chain KYC:
//
//   control proof     you hold the key to this address. Says nothing whatever
//                     about who you are.
//   identity binding  this address belongs to the DigiLocker subject that was
//                     verified for this vendor. Without it, anyone who proved
//                     control of any address could attach it to any identity.
//   callback          a channel the registry or DigiLocker ALREADY KNEW
//                     confirmed it — never one supplied alongside the wallet,
//                     which is what stops an attacker confirming their own
//                     submitted number (D05).
//   grant KYC         the token's own compliance list now contains the address.
//
// WHY THIS IS SHARED. It used to live only in the payee's flow, because only
// the payee had an address. Now the payer funds escrows from their own wallet,
// so their address is a subject of exactly the same checks — the escrow
// contract refunds to whoever sent the lock, which makes the payer's address as
// much a custody question as the payee's. Two copies of a four-gate security
// sequence is two places for one of the gates to quietly go missing.
//
// Spec: docs/architecture.md §4.1, D04/D05

import {
  CONTROL_STATEMENT,
  IDENTITY_BINDING_TYPES,
  WALLET_CONTROL_TYPES,
  domainFor,
} from "@cp/shared-types";
import { NETWORK } from "./chain";
import { api, messageOf } from "./flow";
import type { PayeeSigner } from "./wallet";

/** The four gates, in the only order they can be passed. */
export type WalletStageId = "wallet" | "binding" | "callback" | "kyc";

export type WalletOnboardingReport = {
  /** A line for the activity log. */
  say: (line: string) => void;
  /** Progress for the stage list. */
  stage: (id: WalletStageId, state: "running" | "ok" | "failed", detail?: string) => void;
};

export type WalletOnboardingInput = {
  vendorId: string;
  signer: PayeeSigner;
  token: string;
  chainId: number;
  /** Already-registered wallet for this vendor, when one is known. */
  walletId?: string | null;
  /** Recorded as the confirming operator. Shows up in the audit trail. */
  confirmedBy: string;
  /** Called as soon as the wallet id exists, so a caller can persist it. */
  onWalletRegistered?: (walletId: string) => void;
  report: WalletOnboardingReport;
};

/**
 * Runs the four gates, resuming wherever the vendor already is.
 *
 * Each step throws on failure rather than skipping. An earlier version used
 * `if (ok)` with no else, so a failure silently passed over the step and the
 * wallet stayed unconfirmed with nothing on screen saying why.
 */
export async function onboardWallet(input: WalletOnboardingInput): Promise<{ walletId: string }> {
  const { vendorId, signer, token: t, chainId, confirmedBy, report } = input;
  const { say, stage } = report;

  // 1 — register the address and prove the key
  stage("wallet", "running");
  let walletId = input.walletId ?? null;
  if (!walletId) {
    const reg = await api(`/vendors/${vendorId}/wallets`, {
      method: "POST",
      token: t,
      body: { address: signer.address, network: NETWORK },
    });
    if (!reg.ok) throw new Error(`register wallet → ${messageOf(reg.body)}`);
    const { walletId: id, controlProofNonce } = reg.body as {
      walletId: string;
      controlProofNonce: `0x${string}`;
    };
    walletId = id;
    input.onWalletRegistered?.(id);

    const controlSig = await signer.client.signTypedData({
      account: signer.address,
      domain: domainFor(chainId),
      types: WALLET_CONTROL_TYPES,
      primaryType: "WalletControlProof",
      message: {
        vendorId,
        walletAddress: signer.address,
        network: NETWORK,
        nonce: controlProofNonce,
        statement: CONTROL_STATEMENT,
      },
    });
    const cp = await api(`/vendors/${vendorId}/wallets/${walletId}/control-proof`, {
      method: "POST",
      token: t,
      body: { signature: controlSig },
    });
    if (!cp.ok) throw new Error(`control-proof → ${messageOf(cp.body)}`);
    say("control proof accepted");
    stage("wallet", "ok", "control proof accepted");
  } else {
    stage("wallet", "ok", "already registered");
  }

  // ALREADY CONFIRMED MEANS ALREADY THROUGH ALL THREE. The API sets that status
  // only when the control proof, the binding and the callback have each passed,
  // so re-running them is not just wasted work — the callback refuses outright
  // ("wallet is already confirmed") and a finished account could never press
  // this button again without seeing an error for something that had succeeded.
  const existing = await api(`/vendors/${vendorId}/wallets`, { token: t });
  const confirmed =
    existing.ok &&
    (existing.body as { id: string; status: string }[]).some(
      (w) => w.id === walletId && w.status === "CONFIRMED",
    );

  if (confirmed) {
    stage("binding", "ok", "already bound");
    stage("callback", "ok", "already confirmed");
  } else {
    await bindAndConfirm({ vendorId, walletId, signer, token: t, confirmedBy, report });
  }

  // 4 — the token's own compliance list
  stage("kyc", "running");
  const grant = await api(`/vendors/${vendorId}/wallets/${walletId}/grant-kyc`, {
    method: "POST",
    token: t,
    body: {},
  });
  if (!grant.ok) throw new Error(`grant-kyc → ${messageOf(grant.body)}`);
  const { txHash } = grant.body as { txHash?: string };
  say(`on-chain KYC granted${txHash ? ` — ${txHash.slice(0, 18)}…` : ""}`);
  stage("kyc", "ok", txHash ?? "granted");

  return { walletId };
}

/** Gates two and three, split out so a confirmed wallet can skip both. */
async function bindAndConfirm(input: {
  vendorId: string;
  walletId: string;
  signer: PayeeSigner;
  token: string;
  confirmedBy: string;
  report: WalletOnboardingReport;
}): Promise<void> {
  const { vendorId, walletId, signer, token: t, confirmedBy } = input;
  const { say, stage } = input.report;

  // 2 — bind the address to the verified identity
  stage("binding", "running");
  const prepared = await api(`/vendors/${vendorId}/wallets/${walletId}/identity-binding-message`, {
    token: t,
  });
  if (!prepared.ok) throw new Error(`identity-binding-message → ${messageOf(prepared.body)}`);

  const { domain, message } = prepared.body as {
    domain: { name: string; version: string; chainId: number };
    message: Record<string, string>;
  };
  const bindingSig = await signer.client.signTypedData({
    account: signer.address,
    domain,
    types: IDENTITY_BINDING_TYPES,
    primaryType: "IdentityBinding",
    message: message as never,
  });
  const bind = await api(`/vendors/${vendorId}/wallets/${walletId}/identity-binding`, {
    method: "POST",
    token: t,
    body: { signature: bindingSig },
  });
  if (!bind.ok) throw new Error(`identity-binding → ${messageOf(bind.body)}`);
  say("identity binding accepted");
  stage("binding", "ok", "address bound to your DigiLocker subject");

  // 3 — confirmed out of band, on a channel already on file
  stage("callback", "running");
  const channels = await api(`/vendors/${vendorId}/wallets/${walletId}/callback-channels`, {
    token: t,
  });
  if (!channels.ok) throw new Error(`callback-channels → ${messageOf(channels.body)}`);

  const list = (channels.body as { channels: { value: string; source: string }[] }).channels;
  if (!list[0]) {
    throw new Error(
      "no independent contact on file, so nothing may confirm this wallet. " +
        "Confirmation has to reach a channel the registry or DigiLocker already knew — " +
        "never one supplied with the wallet (D05).",
    );
  }

  const confirm = await api(`/vendors/${vendorId}/wallets/${walletId}/callback-confirm`, {
    method: "POST",
    token: t,
    body: { confirmedBy, channelUsed: list[0].value },
  });
  if (!confirm.ok) throw new Error(`callback-confirm → ${messageOf(confirm.body)}`);
  say(`wallet CONFIRMED via ${list[0].source}`);
  stage("callback", "ok", `confirmed via ${list[0].source}`);
}
