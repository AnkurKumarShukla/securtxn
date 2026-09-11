// EIP-712 domain and typed-data definitions.
//
// WHY THESE LIVE IN SHARED-TYPES. A signature is only valid if the signer and
// the verifier hashed byte-identical structs. The verifier is apps/api; the
// signers are the web console, the approval bridge and the test suite. A second
// copy of a type array — even one that merely reorders two fields, or changes
// "I control this wallet." by a full stop — produces signatures that fail with
// no useful error, because the recovered address is simply a different address.
//
// So there is exactly one definition, here, and everything imports it.
//
// Spec: docs/architecture.md §4.7, §5

export const DOMAIN_NAME = "ConfirmedPayee";
export const DOMAIN_VERSION = "1";

export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
};

export function domainFor(chainId: number): Eip712Domain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId };
}

export const STATEMENT = "I affirm this information is true and this wallet is mine.";
export const CONTROL_STATEMENT = "I control this wallet.";
export const ACK_STATEMENT = "I acknowledge receipt of this payment.";
export const SECRET_RELEASE_STATEMENT = "I am the payee and I am collecting this payment.";
export const PAYEE_CONSENT_STATEMENT =
  "I accept this payment and consent to verification of my identity for it.";

/** O4 — "I hold the key to this address." Says nothing about who the signer is. */
export const WALLET_CONTROL_TYPES = {
  WalletControlProof: [
    { name: "vendorId", type: "string" },
    { name: "walletAddress", type: "address" },
    { name: "network", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
} as const;

/** O5 — binds that key to a DigiLocker subject and to this onboarding attempt. */
export const IDENTITY_BINDING_TYPES = {
  IdentityBinding: [
    { name: "onboardingSessionNonce", type: "bytes32" },
    { name: "digilockerUserId", type: "string" },
    { name: "walletAddress", type: "address" },
    { name: "aadhaarDocHash", type: "bytes32" },
    { name: "panDocHash", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
} as const;

/** P4 — the payee agreeing to be paid, and to be verified, for THIS payment. */
export const PAYEE_CONSENT_TYPES = {
  PayeeConsent: [
    { name: "paymentRequestId", type: "string" },
    { name: "payeeAddress", type: "address" },
    { name: "amount", type: "string" },
    { name: "token", type: "string" },
    { name: "invoiceRef", type: "string" },
    { name: "statement", type: "string" },
  ],
} as const;

/** Non-repudiation of receipt, for the manual acknowledgment path. */
export const ACK_TYPES = {
  RecipientAcknowledgment: [
    { name: "paymentRequestId", type: "string" },
    { name: "recipientAddress", type: "address" },
    { name: "commitment", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
} as const;

/** Proof of control of the payout address, before the escrow secret is handed over. */
export const SECRET_RELEASE_TYPES = {
  SecretRelease: [
    { name: "paymentRequestId", type: "string" },
    { name: "recipientAddress", type: "address" },
    { name: "lockId", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
} as const;
