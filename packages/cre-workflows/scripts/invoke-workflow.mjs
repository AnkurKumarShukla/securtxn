// Invokes the DEPLOYED workflow's HTTP trigger over the CRE gateway, then
// polls each execution to its terminal state and prints the verdict.
//
// Why this exists: `cre workflow simulate` runs the WASM locally and proves
// the branch logic; it does not prove the deployment. The gateway's immediate
// "ACCEPTED" does not either — it only means the request was queued. Three
// ACCEPTED responses once sat next to three executions that had each FAILED in
// 0ms without entering the handler (D47). Nothing here reports success that
// was not read back off a finished execution.
//
// Protocol (docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/
// triggering-deployed-workflows):
//   - JSON-RPC `workflows.execute` to the tenant gateway
//   - Authorization: Bearer <JWT> where alg="ETH"
//   - JWT payload.digest = SHA256 of the request body, keys sorted at EVERY level
//   - JWT signature = EIP-191 personal_sign over "<b64u(header)>.<b64u(payload)>",
//     serialized r||s||v and base64url-encoded, with v as the raw recovery id
//
// Usage (from the repo root, so .env resolves):
//   node packages/cre-workflows/scripts/invoke-workflow.mjs

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes } from "viem";

const execFileAsync = promisify(execFile);

const GATEWAY = process.env.CRE_GATEWAY_URL;
const WORKFLOW_ID = process.env.CRE_WORKFLOW_ID;
const CALLER_PK = process.env.CRE_CALLER_PRIVATE_KEY;
const CRE_BIN =
  process.env.CRE_BIN ?? `${process.env.LOCALAPPDATA ?? ""}\\Programs\\cre\\cre.exe`;

for (const [name, value] of Object.entries({
  CRE_GATEWAY_URL: GATEWAY,
  CRE_WORKFLOW_ID: WORKFLOW_ID,
  CRE_CALLER_PRIVATE_KEY: CALLER_PK,
})) {
  if (!value) throw new Error(`${name} is not set — load the repo .env first`);
}

const account = privateKeyToAccount(CALLER_PK);

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Keys sorted at every level of nesting, per the digest spec. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

async function invoke(label, input) {
  const body = {
    id: randomUUID(),
    jsonrpc: "2.0",
    method: "workflows.execute",
    params: { input, workflow: { workflowID: WORKFLOW_ID } },
  };

  const digest =
    "0x" + createHash("sha256").update(JSON.stringify(canonical(body)), "utf8").digest("hex");

  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "ETH", typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({ digest, iss: account.address, iat: now, exp: now + 300, jti: randomUUID() }),
  );

  // EIP-191 personal_sign; viem applies the "\x19Ethereum Signed Message:\n"
  // prefix and keccak256 internally.
  const sig = new Uint8Array(hexToBytes(await account.signMessage({ message: `${header}.${payload}` })));
  // viem returns v as 27/28; the gateway wants the raw recovery id.
  if (sig[64] >= 27) sig[64] -= 27;
  const jwt = `${header}.${payload}.${b64u(sig)}`;

  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  // The gateway rate-limits invocations (-32002). A 429 says nothing about the
  // workflow, so it must be retried rather than counted as a failed case —
  // otherwise the summary blames the workflow for the harness being impatient.
  if (res.status === 429) return { rateLimited: true, text };

  if (!res.ok) {
    console.log(`[${label}] gateway HTTP ${res.status}: ${text.slice(0, 300)}`);
    return null;
  }
  const id = JSON.parse(text)?.result?.workflow_execution_id ?? null;
  console.log(`[${label}] queued -> ${id ?? text.slice(0, 200)}`);
  return id;
}

/**
 * Reads an execution back to a terminal state. ACCEPTED alone proves nothing.
 *
 * The gateway returns the execution id 0x-prefixed; `cre execution status`
 * rejects that exact string as "not a valid execution UUID or on-chain
 * execution ID". The prefix has to come off before the CLI will accept it.
 */
async function settle(executionId, { attempts = 12, delayMs = 5000 } = {}) {
  const cliId = executionId.replace(/^0x/, "");
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    let out = "";
    try {
      const r = await execFileAsync(CRE_BIN, ["execution", "status", cliId], {
        maxBuffer: 1024 * 1024,
      });
      out = r.stdout;
    } catch (err) {
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    const status = out.match(/Status:\s*(\w+)/)?.[1];
    // Anything not in this set is terminal. Getting this list wrong is not a
    // harmless bug: treating IN_PROGRESS as terminal reports a still-running
    // execution as a failure.
    if (status && !["RUNNING", "PENDING", "IN_PROGRESS", "ACCEPTED"].includes(status)) {
      const errors = out.match(/Top-Level Errors:\s*\n((?:\s+- .*\n?)+)/)?.[1]?.trim();
      return { status, errors, raw: out };
    }
  }
  return { status: "TIMED_OUT" };
}

const V = "00000000-0000-4000-8000-000000000001";
const W = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Each case names the verdict the DEPLOYED workflow must reach. The negative
// cases matter most: a matcher that returns MATCHED for everything passes the
// happy path and is worthless.
const cases = [
  ["MATCHED", { vendorId: V, claimedLegalName: "MERIDIAN COMPONENTS PRIVATE LIMITED", walletAddress: W, network: "ethereum", tokenContract: T }],
  ["WALLET_NOT_ON_FILE", { vendorId: V, claimedLegalName: "Meridian Components Pvt Ltd", walletAddress: "0x1234567890123456789012345678901234567890", network: "ethereum" }],
  ["NAME_BELOW_THRESHOLD", { vendorId: V, claimedLegalName: "Totally Different Corp", walletAddress: W, network: "ethereum", tokenContract: T }],
  ["VENDOR_NOT_FOUND", { vendorId: "00000000-0000-4000-8000-00000000dead", claimedLegalName: "Nobody Ltd", walletAddress: W, network: "ethereum" }],
];

console.log(`caller  : ${account.address}`);
console.log(`workflow: ${WORKFLOW_ID}`);
console.log(`gateway : ${GATEWAY}\n`);

/** Invokes, backing off until the gateway stops rate-limiting us. */
async function invokeWithBackoff(label, input, { attempts = 6 } = {}) {
  let wait = 15000;
  for (let i = 0; i < attempts; i++) {
    const result = await invoke(label, input);
    if (!result?.rateLimited) return result;
    console.log(`[${label}] rate limited, retrying in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 120000);
  }
  console.log(`[${label}] gave up: still rate limited`);
  return null;
}

const queued = [];
for (const [label, input] of cases) {
  queued.push([label, await invokeWithBackoff(label, input)]);
  await new Promise((r) => setTimeout(r, 15000));
}

console.log("\nwaiting for executions to settle...\n");

let failures = 0;
for (const [label, id] of queued) {
  if (!id) {
    console.log(`✗ ${label}: never queued`);
    failures++;
    continue;
  }
  const { status, errors } = await settle(id);
  const mark = status === "SUCCESS" ? "✓" : "✗";
  if (status !== "SUCCESS") failures++;
  console.log(`${mark} ${label.padEnd(20)} ${status}  ${id}`);
  if (errors) console.log(`    ${errors.replace(/\n\s*/g, "\n    ")}`);
}

console.log(
  failures === 0
    ? "\nall executions reached SUCCESS on the deployed workflow"
    : `\n${failures}/${queued.length} executions did not succeed`,
);
process.exit(failures === 0 ? 0 : 1);
