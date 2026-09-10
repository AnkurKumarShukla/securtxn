// Proves the Hedera ATS deployment is REAL, by asking the public mirror node.
//
// WHY THIS FILE EXISTS: `compliance.test.ts` — the other 11 tests in this
// package — asserts ABI shapes and exercises MockComplianceGateway. Not one of
// them touches a chain. So a green `pnpm test` proved the mock worked and said
// nothing whatsoever about Hedera. A reviewer running the suite and concluding
// "the on-chain integration is tested" would have been misled, which is exactly
// the failure D44 was written about.
//
// This test closes that gap. It queries the PUBLIC Hedera testnet mirror node —
// no key, no auth, no account needed — and checks the deployment recorded in
// fixtures/hedera/deployment.json is still there and was actually used. Anyone
// can run it, including a judge, and nothing about it depends on trusting us.
//
// It deliberately does NOT broadcast anything. Reads only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ORACLE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "fixtures", "hedera", "deployment.json"),
    "utf8",
  ),
) as {
  mirror_node: string;
  chain_id: number;
  contracts: Record<string, { id: string; evm_address?: string; created_timestamp?: string }>;
  expected_activity: {
    min_successful_calls: number;
    min_reverted_calls: number;
    selectors: Record<string, string>;
    compliance_revert: { selector: string; error_prefix: string };
  };
};

const MIRROR = ORACLE.mirror_node;
const TIMEOUT = 30_000;

type ContractResult = {
  timestamp: string;
  function_parameters?: string;
  error_message?: string | null;
};

async function mirror<T>(path: string): Promise<T> {
  const response = await fetch(`${MIRROR}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) throw new Error(`mirror node ${path} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The mirror node is a live public service. If it is unreachable the honest
 * outcome is an explicit failure, not a silent pass — a test that quietly skips
 * when the network is down is a test that reports "on-chain verified" on a
 * laptop in aeroplane mode.
 *
 * `reachable` is checked once so an outage produces ONE clear failure rather
 * than a wall of confusing assertion errors.
 */
let reachable = false;
let reachabilityError = "";

beforeAll(async () => {
  try {
    await mirror("/network/nodes?limit=1");
    reachable = true;
  } catch (error) {
    reachabilityError = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT + 5_000);

describe("Hedera testnet mirror node", () => {
  it("is reachable — every assertion below depends on it", () => {
    expect(
      reachable,
      `Cannot reach ${MIRROR}. These tests verify a real deployment, so an ` +
        `unreachable mirror node means UNVERIFIED, not "passed": ${reachabilityError}`,
    ).toBe(true);
  });
});

describe("ATS deployment exists on Hedera testnet", () => {
  it.each(Object.entries(ORACLE.contracts))(
    "%s contract is deployed and not deleted",
    async (_name, expected) => {
      const contract = await mirror<{
        contract_id: string;
        evm_address: string;
        deleted: boolean;
      }>(`/contracts/${expected.id}`);

      expect(contract.contract_id).toBe(expected.id);
      // A deleted contract still resolves, so "it exists" is not enough.
      expect(contract.deleted).toBe(false);

      if (expected.evm_address) {
        expect(contract.evm_address.toLowerCase()).toBe(expected.evm_address.toLowerCase());
      }
    },
    TIMEOUT + 5_000,
  );

  it("the bond was created when we recorded it, not swapped for another", async () => {
    const bond = ORACLE.contracts.bond!;
    const contract = await mirror<{ created_timestamp: string }>(`/contracts/${bond.id}`);
    expect(contract.created_timestamp).toBe(bond.created_timestamp);
  }, TIMEOUT + 5_000);
});

describe("the bond was exercised, not merely deployed", () => {
  let results: ContractResult[] = [];

  beforeAll(async () => {
    if (!reachable) return;
    const page = await mirror<{ results: ContractResult[] }>(
      `/contracts/${ORACLE.contracts.bond!.id}/results?limit=100&order=desc`,
    );
    results = page.results ?? [];
  }, TIMEOUT + 5_000);

  it("has real successful calls against it", () => {
    const ok = results.filter((r) => !r.error_message);
    expect(ok.length).toBeGreaterThanOrEqual(ORACLE.expected_activity.min_successful_calls);
  });

  it.each(Object.entries(ORACLE.expected_activity.selectors))(
    "shows a call to %s (%s)",
    (selector) => {
      // Deploying a token proves nothing about whether it works. Mint, transfer
      // and approve landing on-chain is what makes it a used asset.
      const called = results.some((r) => (r.function_parameters ?? "").startsWith(selector));
      expect(called, `no call to ${selector} found in the bond's history`).toBe(true);
    },
  );

  it("shows the compliance gate REFUSING a transfer on-chain (D53)", () => {
    // The most valuable single fact in the B1 track: the restriction is
    // enforced by the contract, not by our application politely declining. A
    // reverted call is the only way to demonstrate that from outside.
    const reverted = results.filter((r) => r.error_message);
    expect(reverted.length).toBeGreaterThanOrEqual(ORACLE.expected_activity.min_reverted_calls);

    const gate = ORACLE.expected_activity.compliance_revert;
    const match = reverted.some((r) => (r.error_message ?? "").startsWith(gate.error_prefix));
    expect(
      match,
      `expected a revert whose error data begins ${gate.error_prefix} — that is the compliance error`,
    ).toBe(true);
  });
});
