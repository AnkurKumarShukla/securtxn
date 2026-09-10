import { describe, expect, it } from "vitest";
import {
  MockTransport,
  UnavailableTransport,
  decryptKeystore,
  type SendRequest,
} from "../src/wallet-cli.js";

const request: SendRequest = {
  to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  amount: "12500.5",
  token: "USDC",
  network: "ethereum",
  settlementMode: "DIRECT",
};

describe("mock transport", () => {
  it("returns a well-formed hash", async () => {
    const result = await new MockTransport().send(request);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("declares that it did not broadcast", async () => {
    // The flag exists so a caller can never present a synthetic hash as a real
    // send. A plausible-looking fake hash is how a demo accidentally claims a
    // transaction that never happened (D32).
    const result = await new MockTransport().send(request);
    expect(result.broadcast).toBe(false);
    expect(result.transport).toBe("mock");
  });

  it("carries the settlement mode through the seam", async () => {
    // The transport has to know which shape it is signing. A transport that
    // ignored the mode would send a plain transfer for a payment the operator
    // approved as an escrow, and that money would be gone for good (D41).
    const escrow: SendRequest = { ...request, settlementMode: "HTLC" };
    const result = await new MockTransport().send(escrow);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.broadcast).toBe(false);
  });

  it("never repeats a hash", async () => {
    const a = await new MockTransport().send(request);
    const b = await new MockTransport().send(request);
    expect(a.txHash).not.toBe(b.txHash);
  });
});

describe("unavailable transports", () => {
  it.each(["usb", "speculos"] as const)("%s fails loudly rather than silently", async (kind) => {
    // Named and selectable, but honest about not existing — never a silent
    // fallback to mock, which would look like a hardware send (D21, D32).
    const transport = new UnavailableTransport(kind);
    await expect(transport.send()).rejects.toThrow(/not implemented/i);
    await expect(transport.send()).rejects.toThrow(/mock or =local/);
  });
});

describe("keystore decryption", () => {
  // A real Web3 Secret Storage v3 file (pbkdf2 variant) from the standard test
  // vectors. Password: "testpassword".
  const keystore = {
    version: 3,
    id: "3198bc9c-6672-5ab3-d995-4942343ae5b6",
    crypto: {
      ciphertext: "5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46",
      cipherparams: { iv: "6087dab2f9fdbbfaddc31a909735c1e6" },
      cipher: "aes-128-ctr",
      kdf: "pbkdf2",
      kdfparams: {
        c: 262144,
        dklen: 32,
        prf: "hmac-sha256",
        salt: "ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd",
      },
      mac: "517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2",
    },
  };

  it("recovers the private key with the correct password", () => {
    expect(decryptKeystore(keystore, "testpassword")).toBe(
      "0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d",
    );
  });

  it("rejects a wrong password via the MAC rather than returning garbage", () => {
    // Without the MAC check a wrong password yields plausible-looking bytes
    // that would then be used as a signing key.
    expect(() => decryptKeystore(keystore, "wrong")).toThrow(/MAC mismatch/);
  });

  it("rejects a tampered ciphertext", () => {
    const altered = {
      ...keystore,
      crypto: { ...keystore.crypto, ciphertext: keystore.crypto.ciphertext.replace(/^5/, "6") },
    };
    expect(() => decryptKeystore(altered, "testpassword")).toThrow(/MAC mismatch/);
  });

  it("refuses an unsupported keystore version", () => {
    expect(() => decryptKeystore({ ...keystore, version: 1 }, "testpassword")).toThrow(/version 1/);
  });
});
