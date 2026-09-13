// The chain, in one place.
//
// Hedera testnet and nothing else. There used to be two chain ids in this app —
// one for the EIP-712 domain a payee signs and one for the network a
// transaction went to — and they disagreed. A domain separator only has to
// match between signer and verifier, so a wrong-but-consistent value verifies
// fine and silently binds every signature to a chain the money never touches.
// One constant, read by the signer, the claim and the escrow alike.

import { defineChain } from "viem";

export const RPC_URL =
  process.env.NEXT_PUBLIC_HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_HEDERA_CHAIN_ID ?? "296");

/** What MetaMask needs to switch to this network, or to add it if it is absent. */
export const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}` as const;

export const hederaTestnet = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 295 ? "Hedera Mainnet" : "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: {
      name: "HashScan",
      url: `https://hashscan.io/${CHAIN_ID === 295 ? "mainnet" : "testnet"}`,
    },
  },
});

/**
 * The parameters `wallet_addEthereumChain` wants.
 *
 * NOTE the 18 decimals. HBAR has 8 decimals natively on Hedera, but the EVM
 * layer presents it with 18 so that contracts written for Ethereum do not have
 * to be rewritten. Telling MetaMask 8 here makes every balance it displays
 * wrong by ten orders of magnitude.
 */
export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: hederaTestnet.name,
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [hederaTestnet.blockExplorers.default.url],
} as const;

/**
 * The network name a wallet is REGISTERED under.
 *
 * Derived from the chain rather than written out, because it was written out —
 * every wallet was registered as "ethereum" while the money moved on Hedera.
 * Nothing failed, which is what made it easy to miss: a payment's network must
 * equal its wallet's, and both agreed on the wrong answer. It surfaced only as
 * the word "ethereum" on a screen about a Hedera payment.
 */
export const NETWORK: "hedera" | "ethereum" =
  CHAIN_ID === 295 || CHAIN_ID === 296 ? "hedera" : "ethereum";
