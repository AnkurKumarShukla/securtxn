// HMAC and authenticated encryption for data at rest.
//
// Two different tools for two different jobs, and mixing them up is the usual
// mistake:
//
//   HMAC      one-way, deterministic. For values you only ever need to MATCH
//             (tax id, PAN). Deterministic is the point — it lets you find a
//             duplicate without storing the original.
//   AES-GCM   reversible, non-deterministic. For values you must READ back
//             (portrait, address, DOB). Never deterministic, so two identical
//             plaintexts do not produce identical ciphertext.
//
// Spec: docs/architecture.md §5

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;

export type Ciphertext = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

/**
 * Keyed digest for values that are only ever compared, never read back.
 *
 * The pepper is a server-side secret, not a salt: without it, a PAN's small
 * search space makes an unsalted hash trivially reversible by brute force.
 * Rotating it invalidates every stored digest.
 */
export function hmac(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value.trim().toUpperCase()).digest("hex");
}

/** Constant-time comparison — a fast `===` on digests leaks via timing. */
export function hmacMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * AES-256-GCM. Authenticated: decryption fails loudly if the ciphertext was
 * altered, rather than returning plausible garbage.
 *
 * A fresh random IV per call, never reused with the same key — IV reuse in GCM
 * is catastrophic, not merely weak.
 */
export function encrypt(plaintext: Buffer | string, keyHex: string): Ciphertext {
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
    cipher.final(),
  ]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decrypt(payload: Ciphertext, keyHex: string): Buffer {
  const decipher = createDecipheriv(ALGORITHM, parseKey(keyHex), payload.iv);
  decipher.setAuthTag(payload.authTag);
  // Throws on a tampered ciphertext or a wrong key. Let it — a failed
  // decryption is a real problem, not something to paper over with a null.
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

export function encryptJson(value: unknown, keyHex: string): Ciphertext {
  return encrypt(JSON.stringify(value), keyHex);
}

export function decryptJson<T>(payload: Ciphertext, keyHex: string): T {
  return JSON.parse(decrypt(payload, keyHex).toString("utf8")) as T;
}

function parseKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes of hex, got ${key.length}`);
  }
  return key;
}
