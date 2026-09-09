// Invoking a deployed CRE workflow's HTTP trigger over the gateway.
//
// Node-side only — this is the caller's half, not the workflow's. It never
// reaches the WASM build (nothing under the workflow entrypoint imports it).
//
// Protocol (docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/
// triggering-deployed-workflows), each part load-bearing:
//   - JSON-RPC `workflows.execute` to the TENANT gateway. The enterprise
//     gateway host answers "workflow not found" for this tenant even though
//     the JWT authenticates fine — a misleading error worth knowing.
//   - Authorization: Bearer <JWT> with alg "ETH"
//   - payload.digest = SHA256 over the request body with keys sorted at EVERY
//     level of nesting, not just the top
//   - signature = EIP-191 personal_sign over "<b64u(header)>.<b64u(payload)>",
//     serialized r||s||v with v as the RAW recovery id (0/1), not 27/28
//
// Signing is injected rather than importing viem here, so this package keeps
// no wallet dependency of its own — the same reason the vendor lookup is
// injected rather than importing Prisma (D09).

import { createHash, randomUUID } from "node:crypto";

/** EIP-191 personal_sign over `message`, returning a 65-byte 0x signature. */
export type SignMessage = (message: string) => Promise<string>;

export type GatewayOptions = {
  gatewayUrl: string;
  workflowId: string;
  /** Must be listed in the workflow's `authorizedKeys` or the gateway rejects it. */
  callerAddress: string;
  signMessage: SignMessage;
};

export class GatewayRateLimitedError extends Error {
  constructor() {
    super("CRE gateway rate limit exceeded");
    this.name = "GatewayRateLimitedError";
  }
}

const b64u = (input: Uint8Array | string) =>
  Buffer.from(input as Uint8Array).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Keys sorted at every level of nesting, per the digest spec. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Queues one execution. Returns the execution id — NOT a verdict.
 *
 * The gateway is fire-and-forget: it answers `ACCEPTED` once the request is
 * queued and there is no API to read the workflow's return value (D48). An
 * `ACCEPTED` has been observed sitting on top of an execution that had already
 * failed in 0ms (D47), so nothing may treat this resolving as success.
 */
export async function invokeWorkflow(
  options: GatewayOptions,
  input: unknown,
): Promise<{ executionId: string }> {
  const body = {
    id: randomUUID(),
    jsonrpc: "2.0",
    method: "workflows.execute",
    params: { input, workflow: { workflowID: options.workflowId } },
  };

  const digest =
    "0x" + createHash("sha256").update(JSON.stringify(canonical(body)), "utf8").digest("hex");

  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "ETH", typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({
      digest,
      iss: options.callerAddress,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    }),
  );

  const signature = await options.signMessage(`${header}.${payload}`);
  const sig = Uint8Array.from(Buffer.from(signature.replace(/^0x/, ""), "hex"));
  // Wallets return v as 27/28; the gateway wants the raw recovery id.
  if ((sig[64] as number) >= 27) sig[64] = (sig[64] as number) - 27;

  const response = await fetch(options.gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${header}.${payload}.${b64u(sig)}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  // Distinguished from a generic failure so the caller can back off and retry:
  // a rate limit says nothing about the workflow.
  if (response.status === 429) throw new GatewayRateLimitedError();

  if (!response.ok) {
    throw new Error(`CRE gateway returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const executionId = (JSON.parse(text) as { result?: { workflow_execution_id?: string } })?.result
    ?.workflow_execution_id;

  if (!executionId) {
    throw new Error(`CRE gateway accepted the request but returned no execution id: ${text.slice(0, 300)}`);
  }

  return { executionId };
}
