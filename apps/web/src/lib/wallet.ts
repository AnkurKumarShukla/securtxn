"use client";

// Where the payee's signing key lives.
//
// TWO MODES, ONE INTERFACE. Everything downstream — the three onboarding
// signatures, the payment consent, the escrow claim — asks for an address and
// something that can sign. It must not care whether the key is a generated one
// sitting in localStorage or a MetaMask account the person actually owns.
//
//   metamask   the real thing. The key never enters this page, the person
//              approves each signature, and losing your browser storage loses
//              nothing — the wallet is the account.
//   local      a key generated in this tab. Kept because the flow console
//              drives BOTH sides of a payment from one browser, which no
//              single wallet can do, and because it is the only way to run the
//              demo with no extension installed. Clearing site data destroys
//              it and orphans the onboarding.
//
// Both are handed back as a viem WalletClient, because `signTypedData` and
// `writeContract` have identical shapes on one whether the account is local or
// a JSON-RPC account behind an extension. That is what keeps the call sites
// free of branching.
//
// Spec: docs/architecture.md §4.5

import { createWalletClient, custom, http, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADD_CHAIN_PARAMS, CHAIN_ID, CHAIN_ID_HEX, RPC_URL, hederaTestnet } from "./chain";

/** The slice of EIP-1193 this needs. Typed locally so the app takes no wallet SDK. */
type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type WalletMode = "local" | "metamask";

/** An address plus something that will sign for it. */
export type PayeeSigner = {
  mode: WalletMode;
  address: Hex;
  client: WalletClient;
};

/**
 * The injected provider, preferring MetaMask when several extensions collide.
 *
 * Multiple wallets all write to `window.ethereum`; whichever loaded last wins,
 * and some publish the full set under `.providers`. Picking MetaMask out of
 * that list is the difference between "connect" opening the wallet the person
 * expects and it opening whichever one happened to install most recently.
 */
export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const injected = window.ethereum;
  if (!injected) return null;
  if (Array.isArray(injected.providers)) {
    return injected.providers.find((p) => p.isMetaMask) ?? injected.providers[0] ?? null;
  }
  return injected;
}

export function hasInjectedWallet(): boolean {
  return injectedProvider() !== null;
}

/** Error codes the wallet returns that mean something specific to us. */
const USER_REJECTED = 4001;
const CHAIN_NOT_ADDED = 4902;

function codeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

export class WalletError extends Error {
  constructor(
    message: string,
    readonly rejected = false,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * Put the wallet on Hedera before anything is signed.
 *
 * A signature made while the wallet is pointed at another network still
 * SUCCEEDS — the domain separator we pass names Hedera regardless of what the
 * wallet is connected to, so nothing complains. It is the transaction that
 * would then go to the wrong chain. Switching first means the address shown in
 * MetaMask and the address the escrow pays are the same account on the same
 * network, which is the thing a person is actually being asked to check.
 */
async function ensureHederaNetwork(provider: Eip1193Provider): Promise<void> {
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (typeof current === "string" && Number(current) === CHAIN_ID) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (error) {
    if (codeOf(error) === USER_REJECTED) {
      throw new WalletError("You declined the network switch.", true);
    }
    // Hedera is not one of MetaMask's built-in networks, so a first-time user
    // always lands here. Adding it is the expected path, not a fallback.
    if (codeOf(error) === CHAIN_NOT_ADDED) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [ADD_CHAIN_PARAMS],
        });
        return;
      } catch (addError) {
        if (codeOf(addError) === USER_REJECTED) {
          throw new WalletError("You declined adding the Hedera network.", true);
        }
        throw new WalletError(
          `Could not add ${hederaTestnet.name} to your wallet: ${
            addError instanceof Error ? addError.message : String(addError)
          }`,
        );
      }
    }
    throw new WalletError(
      `Could not switch your wallet to ${hederaTestnet.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Prompt for an account and return it, on the right network.
 *
 * `eth_requestAccounts` is the prompting call; `eth_accounts` is the silent one
 * used on reload. Calling the prompting one on every page load is how an app
 * trains people to dismiss its popups.
 */
export async function connectWallet(): Promise<Hex> {
  const provider = injectedProvider();
  if (!provider) {
    throw new WalletError(
      "No wallet extension found. Install MetaMask, then reload this page.",
    );
  }

  let accounts: string[];
  try {
    accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  } catch (error) {
    if (codeOf(error) === USER_REJECTED) {
      throw new WalletError("You declined the connection request.", true);
    }
    throw new WalletError(error instanceof Error ? error.message : String(error));
  }

  const address = accounts[0];
  if (!address) throw new WalletError("Your wallet returned no accounts.");

  await ensureHederaNetwork(provider);
  return address as Hex;
}

/** The connected account without prompting, or null. For restoring on reload. */
export async function silentAccount(): Promise<Hex | null> {
  const provider = injectedProvider();
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return (accounts[0] as Hex | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Fires when the person switches account or network in the extension. */
export function watchWallet(handlers: {
  onAccountsChanged?: (accounts: string[]) => void;
  onChainChanged?: (chainIdHex: string) => void;
}): () => void {
  const provider = injectedProvider();
  if (!provider?.on || !provider.removeListener) return () => {};

  const accounts = handlers.onAccountsChanged as ((...a: never[]) => void) | undefined;
  const chain = handlers.onChainChanged as ((...a: never[]) => void) | undefined;
  if (accounts) provider.on("accountsChanged", accounts);
  if (chain) provider.on("chainChanged", chain);

  return () => {
    if (accounts) provider.removeListener?.("accountsChanged", accounts);
    if (chain) provider.removeListener?.("chainChanged", chain);
  };
}

/**
 * A signer for a MetaMask account.
 *
 * The network is re-checked on every call rather than trusted from connection
 * time, because the person can change it in the extension at any moment and
 * the page is not told until after the fact.
 */
export async function metamaskSigner(expected: Hex): Promise<PayeeSigner> {
  const provider = injectedProvider();
  if (!provider) throw new WalletError("Your wallet extension is no longer available.");

  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  const active = accounts[0] as Hex | undefined;
  if (!active) {
    throw new WalletError("Your wallet is locked or disconnected. Connect it again.");
  }
  // Address comparison is case-insensitive: wallets return EIP-55 checksummed
  // addresses, the API stores whatever it was given, and a mismatch here would
  // read as "wrong account" when it is the same one.
  if (active.toLowerCase() !== expected.toLowerCase()) {
    throw new WalletError(
      `Your wallet is on ${active}, but this onboarding belongs to ${expected}. ` +
        `Switch back to that account in MetaMask.`,
    );
  }

  await ensureHederaNetwork(provider);

  return {
    mode: "metamask",
    address: active,
    client: createWalletClient({
      account: active,
      chain: hederaTestnet,
      transport: custom(provider),
    }),
  };
}

/** A signer for a key generated in this browser. */
export function localSigner(privateKey: Hex): PayeeSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    mode: "local",
    address: account.address,
    client: createWalletClient({ account, chain: hederaTestnet, transport: http(RPC_URL) }),
  };
}
