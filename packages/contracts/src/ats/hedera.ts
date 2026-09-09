// Hedera chain plumbing.
//
// Hedera is EVM-compatible through a JSON-RPC relay rather than natively, and
// it carries two address systems at once: native entity ids (`0.0.9213391`) and
// EVM addresses. Contracts created through a factory get a real EVM address
// that is NOT derivable from the entity id, so translating between them means
// asking the mirror node.
//
// Spec: docs/architecture.md §4.5

import { defineChain, type Chain } from "viem";

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const HEDERA_MAINNET_CHAIN_ID = 295;

export function hederaChain(chainId: number, rpcUrl: string): Chain {
  const testnet = chainId !== HEDERA_MAINNET_CHAIN_ID;
  return defineChain({
    id: chainId,
    name: testnet ? "Hedera Testnet" : "Hedera Mainnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: {
      default: {
        name: "HashScan",
        url: testnet ? "https://hashscan.io/testnet" : "https://hashscan.io/mainnet",
      },
    },
    testnet,
  });
}

/** `0.0.12345` — a native Hedera entity id. */
const HEDERA_ID = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isHederaId(value: string): boolean {
  return HEDERA_ID.test(value);
}

export type AddressResolver = {
  /** Accepts either form and returns an EVM address. */
  toEvmAddress(idOrAddress: string): Promise<`0x${string}`>;
};

/**
 * Resolves entity ids through the mirror node.
 *
 * Deliberately not the "long-zero" derivation (`0x` + padded entity number).
 * That form is only valid for accounts and contracts that never received a
 * distinct EVM address; a contract deployed through the ATS factory has a real
 * one, and using long-zero for it would address a different, non-existent
 * account. Verified: factory `0.0.9213391` resolves to `0xd1f118a4…`, which is
 * nothing like its long-zero form.
 *
 * Results are cached because an entity's EVM address never changes.
 */
export function createAddressResolver(mirrorNodeUrl: string): AddressResolver {
  const cache = new Map<string, `0x${string}`>();
  const base = mirrorNodeUrl.replace(/\/+$/, "");

  return {
    async toEvmAddress(idOrAddress: string): Promise<`0x${string}`> {
      if (EVM_ADDRESS.test(idOrAddress)) return idOrAddress as `0x${string}`;
      if (!isHederaId(idOrAddress)) {
        throw new Error(`'${idOrAddress}' is neither a Hedera id nor an EVM address`);
      }

      const cached = cache.get(idOrAddress);
      if (cached) return cached;

      // Contracts and accounts live under different mirror-node paths, and an
      // id alone does not say which it is — try contract first, then account.
      for (const path of ["contracts", "accounts"]) {
        const response = await fetch(`${base}/${path}/${idOrAddress}`);
        if (!response.ok) continue;

        const body = (await response.json()) as { evm_address?: string; deleted?: boolean };
        if (body.deleted) {
          throw new Error(`Hedera entity '${idOrAddress}' has been deleted`);
        }
        if (body.evm_address && EVM_ADDRESS.test(body.evm_address)) {
          const address = body.evm_address as `0x${string}`;
          cache.set(idOrAddress, address);
          return address;
        }
      }

      throw new Error(`Could not resolve an EVM address for '${idOrAddress}' via the mirror node`);
    },
  };
}

/** HashScan link, for demo output and for the video's on-chain evidence. */
export function hashscanUrl(chainId: number, kind: "contract" | "transaction", id: string): string {
  const network = chainId === HEDERA_MAINNET_CHAIN_ID ? "mainnet" : "testnet";
  return `https://hashscan.io/${network}/${kind}/${id}`;
}
