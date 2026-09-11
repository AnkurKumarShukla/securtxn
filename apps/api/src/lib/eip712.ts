// EIP-712 typed-data definitions and verification.
//
// TWO signatures, proving two different things. Conflating them is the mistake
// this whole design exists to prevent:
//
//   WalletControlProof  "I hold the key to this address."
//                       Says NOTHING about who the signer is. A thief holding a
//                       stolen key signs this correctly.
//
//   IdentityBinding     "I am the person behind this verified identity, this
//                       wallet is mine, and I affirm these documents describe
//                       me."
//                       Carries the onboarding nonce, the DigiLocker user id and
//                       both document hashes, so it cannot be replayed against a
//                       different onboarding attempt or a different identity.
//
// Neither alone is sufficient for CONFIRMED. See D03.
//
// Spec: docs/architecture.md §4.7, §5

import { verifyTypedData, type Address, type Hex } from "viem";

// The struct definitions live in @cp/shared-types so that the signers (the web
// console, the approval bridge, the test suite) and this verifier cannot drift
// apart: a signature is only valid if both sides hashed byte-identical structs,
// and a second copy that merely reordered two fields would fail with no useful
// error. Imported and re-exported here because this module is what the rest of
// apps/api already imports.
import {
  ACK_STATEMENT,
  ACK_TYPES,
  CONTROL_STATEMENT,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  domainFor,
  IDENTITY_BINDING_TYPES,
  PAYEE_CONSENT_STATEMENT,
  PAYEE_CONSENT_TYPES,
  SECRET_RELEASE_STATEMENT,
  SECRET_RELEASE_TYPES,
  STATEMENT,
  WALLET_CONTROL_TYPES,
  type Eip712Domain,
} from "@cp/shared-types";

export {
  ACK_STATEMENT,
  ACK_TYPES,
  CONTROL_STATEMENT,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  domainFor,
  IDENTITY_BINDING_TYPES,
  PAYEE_CONSENT_STATEMENT,
  PAYEE_CONSENT_TYPES,
  SECRET_RELEASE_STATEMENT,
  SECRET_RELEASE_TYPES,
  STATEMENT,
  WALLET_CONTROL_TYPES,
  type Eip712Domain,
};

// --- wallet control proof --------------------------------------------------

export type WalletControlMessage = {
  vendorId: string;
  walletAddress: Address;
  network: string;
  nonce: Hex;
  statement: string;
};

export function buildWalletControlMessage(input: {
  vendorId: string;
  walletAddress: string;
  network: string;
  nonce: string;
}): WalletControlMessage {
  return {
    vendorId: input.vendorId,
    walletAddress: input.walletAddress as Address,
    network: input.network,
    nonce: input.nonce as Hex,
    statement: CONTROL_STATEMENT,
  };
}

// --- identity binding ------------------------------------------------------

export type IdentityBindingMessage = {
  onboardingSessionNonce: Hex;
  digilockerUserId: string;
  walletAddress: Address;
  aadhaarDocHash: Hex;
  panDocHash: Hex;
  statement: string;
};

export function buildIdentityBindingMessage(input: {
  onboardingSessionNonce: string;
  digilockerUserId: string;
  walletAddress: string;
  aadhaarDocHash: string;
  panDocHash: string;
}): IdentityBindingMessage {
  return {
    onboardingSessionNonce: input.onboardingSessionNonce as Hex,
    digilockerUserId: input.digilockerUserId,
    walletAddress: input.walletAddress as Address,
    aadhaarDocHash: withPrefix(input.aadhaarDocHash),
    panDocHash: withPrefix(input.panDocHash),
    statement: STATEMENT,
  };
}

// --- verification ----------------------------------------------------------

/**
 * Verifies a typed-data signature recovers to the claimed address.
 *
 * Never trust a client-asserted signer: the address is an INPUT here, and the
 * signature either recovers to it or the call fails. `verifyTypedData` also
 * handles smart-contract accounts (ERC-1271), which plain ecrecover would
 * reject.
 */
export async function verifyWalletControl(input: {
  chainId: number;
  address: string;
  signature: string;
  message: WalletControlMessage;
}): Promise<boolean> {
  return verifyTypedData({
    address: input.address as Address,
    domain: domainFor(input.chainId),
    types: WALLET_CONTROL_TYPES,
    primaryType: "WalletControlProof",
    message: input.message,
    signature: input.signature as Hex,
  });
}

export async function verifyIdentityBinding(input: {
  chainId: number;
  address: string;
  signature: string;
  message: IdentityBindingMessage;
}): Promise<boolean> {
  return verifyTypedData({
    address: input.address as Address,
    domain: domainFor(input.chainId),
    types: IDENTITY_BINDING_TYPES,
    primaryType: "IdentityBinding",
    message: input.message,
    signature: input.signature as Hex,
  });
}

function withPrefix(hash: string): Hex {
  return (hash.startsWith("0x") ? hash : `0x${hash}`) as Hex;
}

// --- recipient acknowledgment ----------------------------------------------

/**
 * Non-repudiation of receipt.
 *
 * The payee signs a commitment over the payment context, so they cannot later
 * claim the money never arrived. This is the same property the HTLC settlement
 * leg would provide automatically by requiring a preimage reveal (D41) — this
 * is the manual path, and both verify with the code below.
 */
export type AcknowledgmentMessage = {
  paymentRequestId: string;
  recipientAddress: Address;
  commitment: Hex;
  statement: string;
};

export function buildAcknowledgmentMessage(input: {
  paymentRequestId: string;
  recipientAddress: string;
  commitment: string;
}): AcknowledgmentMessage {
  return {
    paymentRequestId: input.paymentRequestId,
    recipientAddress: input.recipientAddress as Address,
    commitment: input.commitment as Hex,
    statement: ACK_STATEMENT,
  };
}

export async function verifyAcknowledgment(input: {
  chainId: number;
  address: string;
  signature: string;
  message: AcknowledgmentMessage;
}): Promise<boolean> {
  return verifyTypedData({
    address: input.address as Address,
    domain: domainFor(input.chainId),
    types: ACK_TYPES,
    primaryType: "RecipientAcknowledgment",
    message: input.message,
    signature: input.signature as Hex,
  });
}

// --- escrow secret release -------------------------------------------------

/**
 * Proof that the caller controls the payout address, before the secret is handed over.
 *
 * The preimage IS the escrow. Anyone holding it can claim the funds, so
 * releasing it on a role token alone would mean the platform's own API key is
 * enough to collect someone else's payment. The payee signs this from the same
 * address the money is locked for, and the signature must recover to it.
 *
 * `lockId` is in the payload so a signature captured for one escrow cannot be
 * replayed to open the next one for the same payee.
 */
export type SecretReleaseMessage = {
  paymentRequestId: string;
  recipientAddress: Address;
  lockId: Hex;
  statement: string;
};

export function buildSecretReleaseMessage(input: {
  paymentRequestId: string;
  recipientAddress: string;
  lockId: string;
}): SecretReleaseMessage {
  return {
    paymentRequestId: input.paymentRequestId,
    recipientAddress: input.recipientAddress as Address,
    lockId: input.lockId as Hex,
    statement: SECRET_RELEASE_STATEMENT,
  };
}

export async function verifySecretRelease(input: {
  chainId: number;
  address: string;
  signature: string;
  message: SecretReleaseMessage;
}): Promise<boolean> {
  return verifyTypedData({
    address: input.address as Address,
    domain: domainFor(input.chainId),
    types: SECRET_RELEASE_TYPES,
    primaryType: "SecretRelease",
    message: input.message,
    signature: input.signature as Hex,
  });
}

// --- payee consent ---------------------------------------------------------

/**
 * The payee agreeing to be paid — and, before that, agreeing to be VERIFIED (P4).
 *
 * This signature is what stops the identity check from being a free oracle. A
 * sender who wants to learn whether some PAN belongs to some address must first
 * get the owner of that address to sign this, for a named amount, against a
 * named invoice. Every probe therefore costs the victim's active participation
 * and leaves them a record of who asked.
 *
 * It is signed by the CONFIRMED wallet, not by an account or a session: the
 * consent has to come from the same key the money will be sent to, or it says
 * nothing about whether that address wants the payment.
 *
 * `amount` and `token` are in the payload deliberately. Consent is to a
 * specific payment, not a standing relationship — a captured signature cannot
 * be replayed to wave through a larger transfer later. `amount` is a string
 * because it is a decimal quantity of tokens as the human agreed to it; putting
 * it through a float on the way to being signed would let the signed value and
 * the stored value disagree.
 */
export type PayeeConsentMessage = {
  paymentRequestId: string;
  payeeAddress: Address;
  amount: string;
  token: string;
  invoiceRef: string;
  statement: string;
};

export function buildPayeeConsentMessage(input: {
  paymentRequestId: string;
  payeeAddress: string;
  amount: string;
  token: string;
  invoiceRef: string;
}): PayeeConsentMessage {
  return {
    paymentRequestId: input.paymentRequestId,
    payeeAddress: input.payeeAddress as Address,
    amount: input.amount,
    token: input.token,
    invoiceRef: input.invoiceRef,
    statement: PAYEE_CONSENT_STATEMENT,
  };
}

export async function verifyPayeeConsent(input: {
  chainId: number;
  address: string;
  signature: string;
  message: PayeeConsentMessage;
}): Promise<boolean> {
  return verifyTypedData({
    address: input.address as Address,
    domain: domainFor(input.chainId),
    types: PAYEE_CONSENT_TYPES,
    primaryType: "PayeeConsent",
    message: input.message,
    signature: input.signature as Hex,
  });
}
