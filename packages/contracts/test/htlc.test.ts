import { describe, expect, it } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import {
  PAYMENT_HTLC_ABI,
  PAYMENT_HTLC_BYTECODE,
  PAYMENT_HTLC_COMPILER,
  computeLockId,
  hashlockFor,
  newPreimage,
  paymentRefFor,
  LOCK_STATUS,
  type LockParams,
} from "../src/index.js";

const PAYER = "0xe894a3f95ea13444B669E9243bA4e7c934CDeC0d" as Address;
const PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const TOKEN = "0x8418e76609e60e16dfa22722e707381da9b9173a" as Address;

const params: LockParams = {
  paymentRef: paymentRefFor("11111111-2222-3333-4444-555555555555"),
  payer: PAYER,
  payee: PAYEE,
  token: TOKEN,
  amount: 50_000n,
  hashlock: hashlockFor(`0x${"11".repeat(32)}`),
  timelock: 1_800_000_000n,
};

describe("hashlock", () => {
  // The contract hashes with keccak256(abi.encodePacked(preimage)), which for a
  // bytes32 is the keccak of exactly those 32 bytes. This vector is the known
  // keccak256 of 32 zero bytes — if the helper ever grew a prefix or an encoding
  // step, it would stop matching and every claim would revert.
  it("is the plain keccak256 of the 32 secret bytes", () => {
    expect(hashlockFor(`0x${"00".repeat(32)}`)).toBe(
      "0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
    );
  });

  it("changes completely when one bit of the preimage changes", () => {
    const a = hashlockFor(`0x${"00".repeat(31)}00`);
    const b = hashlockFor(`0x${"00".repeat(31)}01`);
    expect(a).not.toBe(b);
  });
});

describe("preimage generation", () => {
  it("produces 32 bytes", () => {
    expect(newPreimage()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // A repeated secret would let anyone who saw an earlier claim take a later
  // escrow. This does not prove the source is a CSPRNG, but it does catch a
  // constant or a truncated buffer.
  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 100 }, () => newPreimage()));
    expect(seen.size).toBe(100);
  });
});

describe("payment reference", () => {
  it("commits to the payment id without revealing it", () => {
    const ref = paymentRefFor("11111111-2222-3333-4444-555555555555");
    expect(ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ref).not.toContain("1111-2222");
  });

  it("is stable for the same id and different for another", () => {
    expect(paymentRefFor("abc")).toBe(paymentRefFor("abc"));
    expect(paymentRefFor("abc")).not.toBe(paymentRefFor("abd"));
  });
});

describe("lock id derivation", () => {
  /**
   * An independent implementation of `abi.encode` for this argument list:
   * seven 32-byte words, in declaration order, addresses and uint64 left-padded.
   *
   * Written out by hand on purpose. Comparing viem against viem would only
   * prove viem is consistent with itself; this compares it against the ABI
   * layout the contract actually hashes, and so catches a reordered or dropped
   * field — the failure that would make the client record a lock id the chain
   * has never heard of.
   */
  function encodeByHand(p: LockParams): Hex {
    const word = (value: string): string => value.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    return `0x${[
      word(p.paymentRef),
      word(p.payer),
      word(p.payee),
      word(p.token),
      word(p.amount.toString(16)),
      word(p.hashlock),
      word(p.timelock.toString(16)),
    ].join("")}`;
  }

  it("matches a hand-built ABI encoding", () => {
    expect(computeLockId(params)).toBe(keccak256(encodeByHand(params)));
  });

  it("is deterministic", () => {
    expect(computeLockId(params)).toBe(computeLockId({ ...params }));
  });

  // Every field must be part of the identity. If any one were dropped, two
  // genuinely different locks could collide on an id and the second would be
  // rejected as a duplicate — or worse, claimed against the first.
  it.each([
    ["paymentRef", { paymentRef: paymentRefFor("other") }],
    ["payer", { payer: PAYEE }],
    ["payee", { payee: PAYER }],
    ["token", { token: PAYER }],
    ["amount", { amount: 50_001n }],
    ["hashlock", { hashlock: hashlockFor(`0x${"22".repeat(32)}`) }],
    ["timelock", { timelock: 1_800_000_001n }],
  ])("changes when %s changes", (_label, patch) => {
    expect(computeLockId({ ...params, ...patch })).not.toBe(computeLockId(params));
  });

  it("is case-insensitive on the address arguments", () => {
    // viem checksums; the chain sees the same 20 bytes either way.
    expect(computeLockId({ ...params, payee: PAYEE.toLowerCase() as Address })).toBe(
      computeLockId(params),
    );
  });
});

describe("compiled artifact", () => {
  it("exposes exactly the three state-changing entry points", () => {
    const writes = PAYMENT_HTLC_ABI.filter(
      (item) => item.type === "function" && item.stateMutability === "nonpayable",
    ).map((item) => ("name" in item ? item.name : ""));
    expect(writes.sort()).toEqual(["claim", "lock", "refund"]);
  });

  it("declares lock with the argument list the client encodes", () => {
    const lock = PAYMENT_HTLC_ABI.find((item) => "name" in item && item.name === "lock");
    expect(lock && "inputs" in lock ? lock.inputs.map((i) => i.type) : []).toEqual([
      "bytes32",
      "address",
      "address",
      "uint256",
      "bytes32",
      "uint64",
    ]);
  });

  it("emits an event for each of the three outcomes", () => {
    const events = PAYMENT_HTLC_ABI.filter((item) => item.type === "event").map((item) =>
      "name" in item ? item.name : "",
    );
    expect(events.sort()).toEqual(["Claimed", "Locked", "Refunded"]);
  });

  // The refund path is the product's premise: an unclaimed payment comes back.
  it("declares the timelock guard as a named error, not a bare revert", () => {
    const errors = PAYMENT_HTLC_ABI.filter((item) => item.type === "error").map((item) =>
      "name" in item ? item.name : "",
    );
    expect(errors).toContain("LockNotYetExpired");
    expect(errors).toContain("LockExpired");
    expect(errors).toContain("PreimageDoesNotMatch");
  });

  it("carries deployable bytecode and the settings that produced it", () => {
    expect(PAYMENT_HTLC_BYTECODE).toMatch(/^0x[0-9a-f]{100,}$/);
    expect(PAYMENT_HTLC_COMPILER.evmVersion).toBe("paris");
    expect(PAYMENT_HTLC_COMPILER.optimizer.enabled).toBe(true);
  });
});

describe("status decoding", () => {
  it("maps the on-chain enum by index", () => {
    expect(LOCK_STATUS[0]).toBe("NONE");
    expect(LOCK_STATUS[1]).toBe("LOCKED");
    expect(LOCK_STATUS[2]).toBe("CLAIMED");
    expect(LOCK_STATUS[3]).toBe("REFUNDED");
  });
});
