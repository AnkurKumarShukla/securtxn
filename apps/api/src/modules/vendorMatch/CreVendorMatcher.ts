// VendorMatcher adapter that runs the match on the deployed CRE workflow.
// This is the piece that makes the D09 swap real: apps/api's container.ts
// constructs one of these instead of FallbackVendorMatcher, and the decision
// engine never learns which one it is talking to.
//
// SHAPE OF THE EXCHANGE, and why it is not a plain request/response (D48):
// CRE's HTTP trigger is fire-and-forget. `workflows.execute` returns an
// execution id, and there is no API to read the workflow's return value. So:
//
//   1. persist a PENDING row and get a requestId
//   2. invoke the trigger with that requestId in the input
//   3. the workflow posts its verdict to /internal/vendor-match-result
//   4. await the row
//
// Step 1 happens BEFORE step 2 on purpose — it is what lets the callback
// endpoint reject a verdict for a requestId nobody asked for.
//
// Storage is injected rather than imported for the same reason the vendor
// lookup is: this package must not depend on Prisma (D09).
//
// Spec: docs/architecture.md §4.4, docs/decisions.md D48

import type { VendorMatchInput, VendorMatchResult, VendorMatcher } from "@cp/cre-workflows";

export type VendorMatchRequestRecord = {
  status: "PENDING" | "COMPLETED" | "FAILED";
  match: boolean | null;
  score: number | null;
  reasonCode: string | null;
  failureReason: string | null;
};

export interface VendorMatchRequestStore {
  /** Persists a PENDING request and returns its id. Must happen before invoking. */
  create(input: VendorMatchInput): Promise<string>;
  /** Records the gateway's execution id so a stuck request can be traced. */
  attachExecution(requestId: string, executionId: string): Promise<void>;
  get(requestId: string): Promise<VendorMatchRequestRecord | null>;
  fail(requestId: string, reason: string): Promise<void>;
}

export type CreVendorMatcherOptions = {
  store: VendorMatchRequestStore;
  /** Queues one execution. Resolving means QUEUED, never "succeeded" (D47). */
  invoke: (input: VendorMatchInput & { requestId: string }) => Promise<{ executionId: string }>;
  /**
   * How long to wait for the verdict callback. Observed executions settle in
   * 4-7s, so this is deliberately generous rather than tight — but it is a
   * bound, not a hope: without one a stalled workflow would hang a payment.
   */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected for tests, so waiting does not mean sleeping. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Raised when the verdict never arrived. NOT a negative verdict — see below. */
export class VendorMatchTimeoutError extends Error {
  constructor(public readonly requestId: string, timeoutMs: number) {
    super(`CRE vendor match ${requestId} produced no verdict within ${timeoutMs}ms`);
    this.name = "VendorMatchTimeoutError";
  }
}

/** Raised when the workflow reported it could not produce a verdict. */
export class VendorMatchFailedError extends Error {
  constructor(public readonly requestId: string, reason: string) {
    super(`CRE vendor match ${requestId} failed: ${reason}`);
    this.name = "VendorMatchFailedError";
  }
}

export class CreVendorMatcher implements VendorMatcher {
  constructor(private readonly options: CreVendorMatcherOptions) {}

  async match(input: VendorMatchInput): Promise<VendorMatchResult> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = this.options.now ?? (() => Date.now());

    const requestId = await this.options.store.create(input);

    try {
      const { executionId } = await this.options.invoke({ ...input, requestId });
      await this.options.store.attachExecution(requestId, executionId);
    } catch (error) {
      // The row would otherwise sit PENDING forever, looking like a slow match
      // rather than one that never started.
      await this.options.store.fail(requestId, `invocation failed: ${describe(error)}`);
      throw error;
    }

    const deadline = now() + timeoutMs;

    for (;;) {
      const record = await this.options.store.get(requestId);

      if (record?.status === "COMPLETED") {
        // A COMPLETED row with no verdict is a bug in the callback, not a
        // negative match, and must not be silently read as one.
        if (record.match === null || record.reasonCode === null) {
          throw new Error(`CRE vendor match ${requestId} completed without a verdict`);
        }
        return { match: record.match, reasonCode: record.reasonCode };
      }

      if (record?.status === "FAILED") {
        throw new VendorMatchFailedError(requestId, record.failureReason ?? "unknown");
      }

      if (now() >= deadline) {
        await this.options.store.fail(requestId, "timed out awaiting verdict");
        throw new VendorMatchTimeoutError(requestId, timeoutMs);
      }

      await sleep(pollIntervalMs);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
