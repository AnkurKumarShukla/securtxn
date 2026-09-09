// The signing transport.
//
// This is the seam. Every transport takes the same input and returns the same
// result, so the surrounding flow — poll, show the operator what they are
// signing, report the outcome — is identical regardless of what holds the key.
// A hardware wallet later is a config value, not a rewrite (D13, D32).
//
//   mock       device-style confirmation, synthetic tx hash, no key anywhere.
//              The default and the CI path.
//   local      encrypted keystore on this machine, password prompted at approve
//              time, real Sepolia broadcast.
//   usb        physical Ledger via @ledgerhq/wallet-cli — declared, 501.
//   speculos   Ledger emulator — declared, 501.
//
// HONEST LIMIT: with `local`, the key is software on the approver's machine.
// "Autonomous code cannot move money" still holds — that is role separation
// plus a human step. "The key cannot be exfiltrated from this machine" does
// NOT. Do not describe it as hardware custody (D32).
//
// Spec: docs/architecture.md §4.3

import { createDecipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BridgeConfig, Transport } from "./config.js";

export type SendRequest = {
  to: string;
  amount: string;
  token: string;
  network: string;
};

export type SendResult = {
  txHash: string;
  confirmedAt: Date;
  /** Which transport produced this, so a caller never mistakes mock for real. */
  transport: Transport;
  /** False for `mock`: no transaction exists on any chain. */
  broadcast: boolean;
};

export interface SigningTransport {
  readonly kind: Transport;
  send(request: SendRequest): Promise<SendResult>;
}

export function createTransport(
  config: BridgeConfig,
  promptPassword: () => Promise<string>,
): SigningTransport {
  switch (config.WALLET_CLI_TRANSPORT) {
    case "mock":
      return new MockTransport();
    case "local":
      return new LocalKeystoreTransport(config, promptPassword);
    case "usb":
    case "speculos":
      return new UnavailableTransport(config.WALLET_CLI_TRANSPORT);
  }
}

/**
 * Signs nothing and broadcasts nothing.
 *
 * The synthetic hash is clearly marked so it can never be mistaken for a real
 * transaction — a plausible-looking fake hash in a demo is how "we sent it" gets
 * claimed about a send that never happened.
 */
export class MockTransport implements SigningTransport {
  readonly kind = "mock" as const;

  async send(request: SendRequest): Promise<SendResult> {
    const seed = `${request.to}|${request.amount}|${request.token}|${Date.now()}|${randomBytes(8).toString("hex")}`;
    return {
      txHash: keccak256(Buffer.from(seed, "utf8")),
      confirmedAt: new Date(),
      transport: this.kind,
      broadcast: false,
    };
  }
}

/** usb / speculos: named, selectable, and honest about not existing yet (D21). */
export class UnavailableTransport implements SigningTransport {
  constructor(readonly kind: Transport) {}

  async send(): Promise<SendResult> {
    throw new Error(
      `Transport '${this.kind}' is not implemented: no hardware wallet is in scope (D32). ` +
        "Use WALLET_CLI_TRANSPORT=mock or =local.",
    );
  }
}

/**
 * Software signer using a Web3 Secret Storage (keystore v3) file.
 *
 * The password is prompted at approve time and never stored, so possession of
 * the file alone is not enough to send.
 */
export class LocalKeystoreTransport implements SigningTransport {
  readonly kind = "local" as const;

  constructor(
    private readonly config: BridgeConfig,
    private readonly promptPassword: () => Promise<string>,
  ) {}

  async send(request: SendRequest): Promise<SendResult> {
    if (!this.config.KEYSTORE_PATH) {
      throw new Error("KEYSTORE_PATH is not set; the local transport has no key to use");
    }
    if (!this.config.SEPOLIA_RPC_URL) {
      throw new Error("SEPOLIA_RPC_URL is not set; the local transport cannot broadcast");
    }

    const password = await this.promptPassword();
    const privateKey = decryptKeystore(
      JSON.parse(readFileSync(this.config.KEYSTORE_PATH, "utf8")),
      password,
    );
    const account = privateKeyToAccount(privateKey);

    // Deliberately not implemented as a native-token transfer: these are ERC-20
    // payouts, and a bare value send would move ETH instead of the token. The
    // encoding and gas handling belong here, wired against the token contract.
    throw new Error(
      `Local broadcast is not wired yet. Keystore unlocked successfully for ${account.address}; ` +
        `next step is an ERC-20 transfer of ${request.amount} ${request.token} to ${request.to} ` +
        `on ${request.network}.`,
    );
  }
}

type KeystoreV3 = {
  version: number;
  crypto: {
    ciphertext: string;
    cipherparams: { iv: string };
    cipher: string;
    kdf: string;
    kdfparams: Record<string, unknown>;
    mac: string;
  };
};

/**
 * Web3 Secret Storage v3 decryption.
 *
 * Implemented directly rather than pulling in a wallet library for one
 * function. The MAC check is not optional: without it a wrong password yields
 * plausible-looking garbage that would be used as a key.
 */
export function decryptKeystore(keystore: KeystoreV3, password: string): Hex {
  if (keystore.version !== 3) {
    throw new Error(`Unsupported keystore version ${keystore.version}; expected 3`);
  }

  const { crypto: c } = keystore;
  const derived = deriveKey(c.kdf, c.kdfparams, password);
  const ciphertext = Buffer.from(c.ciphertext, "hex");

  // MAC over the second half of the derived key plus the ciphertext.
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
  if (mac !== c.mac.toLowerCase().replace(/^0x/, "")) {
    throw new Error("Keystore MAC mismatch: wrong password, or the file has been altered");
  }

  if (c.cipher !== "aes-128-ctr") {
    throw new Error(`Unsupported keystore cipher '${c.cipher}'`);
  }
  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, "hex"),
  );

  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${key.toString("hex")}` as Hex;
}

function deriveKey(kdf: string, params: Record<string, unknown>, password: string): Buffer {
  const salt = Buffer.from(String(params.salt), "hex");
  const dklen = Number(params.dklen ?? 32);

  if (kdf === "scrypt") {
    const n = Number(params.n);
    return scryptSync(Buffer.from(password, "utf8"), salt, dklen, {
      N: n,
      r: Number(params.r),
      p: Number(params.p),
      // Node's default maxmem is too small for the N values wallets use.
      maxmem: 256 * n * Number(params.r) + 64 * 1024 * 1024,
    });
  }

  if (kdf === "pbkdf2") {
    if (params.prf !== undefined && params.prf !== "hmac-sha256") {
      throw new Error(`Unsupported keystore prf '${String(params.prf)}'`);
    }
    return pbkdf2Sync(Buffer.from(password, "utf8"), salt, Number(params.c), dklen, "sha256");
  }

  throw new Error(`Unsupported keystore kdf '${kdf}'`);
}
