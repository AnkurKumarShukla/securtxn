// One Hedera connection, shared by everything that writes to it.
//
// Every script in this package used to build its own public client, wallet
// client, address resolver and receipt-checking helper. That was fine while the
// only callers were scripts. Now the API broadcasts too, and four independent
// copies of the same wiring is four places for the gas limit, the chain
// definition or the revert check to drift.
//
// WHY `confirm` EXISTS. viem resolves `writeContract` as soon as the node
// accepts the transaction, not when it succeeds. A reverted transaction is a
// successful promise with `status: "reverted"` in its receipt, so a caller that
// does not wait and check has no idea whether anything happened. Every write in
// this package goes through it.
//
// Spec: docs/architecture.md §4.5

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAddressResolver, hederaChain } from "./hedera.js";

export type HederaClientOptions = {
  chainId: number;
  rpcUrl: string;
  mirrorNodeUrl: string;
  /** The account that signs. Different callers pass different keys. */
  privateKey: string;
  /**
   * Hedera's relay estimates contract gas poorly, so every write states a
   * limit. One million covers a role grant or a transfer; issuance and minting
   * pass their own higher figures.
   */
  gasLimit?: bigint;
};

export type HederaClients = {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  address: Address;
  gas: bigint;
  /** Accepts a Hedera id (0.0.x) or an EVM address and returns the address. */
  resolve(idOrAddress: string): Promise<Address>;
  /** Waits for the receipt and throws if the transaction reverted. */
  confirm(hash: Hex, label: string): Promise<Hex>;
};

export function createHederaClients(options: HederaClientOptions): HederaClients {
  const chain = hederaChain(options.chainId, options.rpcUrl);
  const account = privateKeyToAccount(options.privateKey as Hex);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(options.rpcUrl), account });
  const resolver = createAddressResolver(options.mirrorNodeUrl);

  return {
    chain,
    publicClient,
    walletClient,
    account,
    address: account.address,
    gas: options.gasLimit ?? 1_000_000n,
    resolve: (idOrAddress) => resolver.toEvmAddress(idOrAddress),
    async confirm(hash, label) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
      return hash;
    },
  };
}
