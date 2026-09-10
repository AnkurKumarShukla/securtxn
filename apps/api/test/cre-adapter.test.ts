// CreVendorMatcher — the adapter that runs a match on the deployed CRE
// workflow and waits for the verdict to come back.
//
// WHAT THIS IS NOT: running the shared VendorMatcher contract
// (vendorMatcher.contract.ts) against the CRE implementation. The matching
// itself happens in the enclave / on the DON, so a stubbed store here would
// only test the stub. That contract runs against evaluateMatch (shared by all
// three implementations since D47) and against the deployed workflow.
//
// WHAT THIS IS: coverage of the adapter's own behaviour — the ordering that
// makes the callback safe, and every way it must refuse to invent a verdict.
// The exchange is asynchronous (D48), so most of the risk lives here rather
// than in a request/response.

import { describe, expect, it, vi } from "vitest";
import {
  CreVendorMatcher,
  VendorMatchFailedError,
  VendorMatchTimeoutError,
  type VendorMatchRequestRecord,
  type VendorMatchRequestStore,
} from "../src/modules/vendorMatch/CreVendorMatcher.js";
import type { VendorMatchInput } from "@cp/cre-workflows";

const INPUT: VendorMatchInput = {
  vendorId: "00000000-0000-4000-8000-000000000001",
  claimedNameHmac: "d:components meridian",
  claimedPanHmac: "d:ABCDE1234F",
  walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  network: "ethereum",
};

const PENDING: VendorMatchRequestRecord = {
  status: "PENDING",
  match: null,
  score: null,
  reasonCode: null,
  failureReason: null,
};

/**
 * An in-memory stand-in for the Prisma store, plus a record of the order calls
 * arrived in — ordering is a correctness property here, not an implementation
 * detail, so it is asserted rather than assumed.
 */
function fakeStore(records: VendorMatchRequestRecord[]) {
  const calls: string[] = [];
  let index = 0;

  const store: VendorMatchRequestStore = {
    create: vi.fn(async () => {
      calls.push("create");
      return "req-1";
    }),
    attachExecution: vi.fn(async () => {
      calls.push("attachExecution");
    }),
    get: vi.fn(async () => {
      calls.push("get");
      return records[Math.min(index++, records.length - 1)] ?? null;
    }),
    fail: vi.fn(async () => {
      calls.push("fail");
    }),
  };

  return { store, calls };
}

function matcher(
  store: VendorMatchRequestStore,
  overrides: Partial<ConstructorParameters<typeof CreVendorMatcher>[0]> = {},
) {
  let clock = 0;
  return new CreVendorMatcher({
    store,
    invoke: vi.fn(async () => ({ executionId: "0xexec" })),
    pollIntervalMs: 1,
    timeoutMs: 100,
    // Time advances only when the matcher sleeps, so a timeout test is
    // deterministic and instant instead of a real 100ms race.
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  });
}

describe("CreVendorMatcher", () => {
  it("returns the verdict once the callback lands", async () => {
    const { store } = fakeStore([
      PENDING,
      { status: "COMPLETED", match: true, score: null, reasonCode: "MATCHED", failureReason: null },
    ]);

    expect(await matcher(store).match(INPUT)).toEqual({
      match: true,
      reasonCode: "MATCHED",
    });
  });

  it("persists the request BEFORE invoking the workflow", async () => {
    // Load-bearing ordering, not style. The callback endpoint rejects a verdict
    // whose requestId it has never seen; if the row were written after the
    // invocation, a fast workflow could call back before the row existed and
    // its verdict would be thrown away as unsolicited.
    const { store, calls } = fakeStore([
      { status: "COMPLETED", match: true, score: null, reasonCode: "MATCHED", failureReason: null },
    ]);
    const invoke = vi.fn(async () => ({ executionId: "0xexec" }));

    await matcher(store, { invoke }).match(INPUT);

    expect(calls.indexOf("create")).toBeLessThan(calls.indexOf("attachExecution"));

    const createOrder = (store.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const invokeOrder = invoke.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(invokeOrder);
  });

  it("passes the requestId to the workflow along with the match input", async () => {
    const { store } = fakeStore([
      { status: "COMPLETED", match: true, score: null, reasonCode: "MATCHED", failureReason: null },
    ]);
    const invoke = vi.fn(async () => ({ executionId: "0xexec" }));

    await matcher(store, { invoke }).match(INPUT);

    expect(invoke).toHaveBeenCalledWith({ ...INPUT, requestId: "req-1" });
  });

  it("records the execution id so a stuck request can be traced", async () => {
    const { store } = fakeStore([
      { status: "COMPLETED", match: false, score: null, reasonCode: "X", failureReason: null },
    ]);

    await matcher(store).match(INPUT);

    expect(store.attachExecution).toHaveBeenCalledWith("req-1", "0xexec");
  });

  it("polls until the verdict arrives instead of giving up on the first PENDING", async () => {
    const { store } = fakeStore([
      PENDING,
      PENDING,
      PENDING,
      {
        status: "COMPLETED",
        match: false,
        score: null,
        reasonCode: "IDENTITY_MISMATCH",
        failureReason: null,
      },
    ]);

    expect(await matcher(store).match(INPUT)).toMatchObject({
      reasonCode: "IDENTITY_MISMATCH",
    });
    expect(store.get).toHaveBeenCalledTimes(4);
  });

  it("throws when the workflow reported a failure — a failure is not a mismatch", async () => {
    // The distinction the decision engine depends on: "we could not check"
    // must never reach it looking like "we checked and it failed."
    const { store } = fakeStore([
      {
        status: "FAILED",
        match: null,
        score: null,
        reasonCode: null,
        failureReason: "vendor lookup failed with status 503",
      },
    ]);

    await expect(matcher(store).match(INPUT)).rejects.toBeInstanceOf(VendorMatchFailedError);
  });

  it("times out rather than waiting forever, and marks the row failed", async () => {
    const { store } = fakeStore([PENDING]);

    await expect(matcher(store).match(INPUT)).rejects.toBeInstanceOf(VendorMatchTimeoutError);
    expect(store.fail).toHaveBeenCalledWith("req-1", "timed out awaiting verdict");
  });

  it("marks the row failed when the invocation itself throws", async () => {
    // Otherwise the row sits PENDING forever, indistinguishable from a slow
    // match rather than one that never started.
    const { store } = fakeStore([PENDING]);
    const invoke = vi.fn(async () => {
      throw new Error("gateway 500");
    });

    await expect(matcher(store, { invoke }).match(INPUT)).rejects.toThrow(/gateway 500/);
    expect(store.fail).toHaveBeenCalledWith("req-1", expect.stringContaining("gateway 500"));
  });

  it("refuses a COMPLETED row that carries no verdict", async () => {
    // A bug in the callback, not a negative match. Reading a null `match` as
    // false would silently turn a broken write into a rejected payment.
    const { store } = fakeStore([
      { status: "COMPLETED", match: null, score: null, reasonCode: null, failureReason: null },
    ]);

    await expect(matcher(store).match(INPUT)).rejects.toThrow(/completed without a verdict/);
  });
});
