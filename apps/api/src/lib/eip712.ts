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

export const DOMAIN_NAME = "ConfirmedPayee";
export const DOMAIN_VERSION = "1";

export const STATEMENT =
  "I affirm this information is true and this wallet is mine.";

export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
};

export function domainFor(chainId: number): Eip712Domain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId };
}

// --- wallet control proof --------------------------------------------------

export const WALLET_CONTROL_TYPES = {
  WalletControlProof: [
    { name: "vendorId", type: "string" },
    { name: "walletAddress", type: "address" },
    { name: "network", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
} as const;

export const CONTROL_STATEMENT = "I control this wallet.";

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
