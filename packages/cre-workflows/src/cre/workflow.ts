// The CRE handler. Vendor PII is fetched and compared away from the caller;
// only the match verdict crosses back out as the handler's return value.
//
// TWO handlers are registered from one code path, selected by config:
//
//   confidential: true  -> cre.handlerInTee, compared inside an AWS Nitro
//                          enclave. This is the product's intended mode and
//                          what the Confidential Workflows track is about.
//   confidential: false -> cre.handler, compared on DON nodes under consensus.
//                          Same rule, same lookup, no enclave.
//
// The non-TEE mode exists because `confidential-workflows` is an entitlement
// granted per workflow, separate from deploy access. Until it is granted, a
// handlerInTee deployment activates but every execution fails in 0ms with
// "confidential-workflows capability is disabled by settings ... not allowed"
// — it never enters the handler. The DON mode proves the whole surrounding
// path (signed JWT -> gateway -> DON -> Vault secret -> lookup -> verdict)
// against the real network while the entitlement is pending. See D47.
//
// Every API used here is checked TWICE against ground truth, not inferred
// from docs prose (this SDK version's guide pages render client-side and did
// not yield code blocks to WebFetch):
//   1. Against the installed @chainlink/cre-sdk (1.20.0) .d.ts files directly.
//   2. Against `cre init --template=hello-confidential-workflows-ts`'s real
//      generated reference implementation, once a `--deployment-registry`
//      flag fixed what first looked like a hang (it was an interactive
//      prompt --non-interactive doesn't cover for that one flag — see
//      docs/decisions.md). That reference caught two things step 1 alone
//      missed: `headers` on an outbound request is a deprecated field —
//      the real field is `multiHeaders`, keyed to an array of values — and
//      the SDK ships `ok()`/`json()` response helpers meant to be used
//      instead of hand-rolling status/body handling.
//
// Do not use ConfidentialHTTPClient here — it lacks the TeeRuntime overload
// this handler needs (confirmed: its sendRequest only accepts
// NodeRuntime/Runtime, not TeeRuntime — see cre-sdk dist/sdk/runtime.d.ts).
//
// Spec: docs/architecture.md §4.4

import {
  consensusIdenticalAggregation,
  cre,
  json,
  ok,
  type Runtime,
  type TeeRuntime,
} from "@chainlink/cre-sdk";
// Type-only, so it is erased before the WASM build and costs nothing at
// runtime. `ok()`/`json()` are overloaded (bare Response, or a lazy thunk),
// and `Parameters<typeof ok>[0]` resolves to the LAST overload — the thunk —
// which is why the response has to be named by its real type rather than
// inferred from the helpers.
import type { HTTP_CLIENT_PB } from "@chainlink/cre-sdk/pb";
import { evaluateMatch, MATCH_REASONS, type VendorRecord } from "../matching.js";
import type { VendorMatchInput, VendorMatchResult } from "../vendorMatch.js";

type HttpResponse = HTTP_CLIENT_PB.Response;

/**
 * Workflow-level config, set at deploy time via config.staging.json (or
 * equivalent per-target file) and available on `runtime.config`.
 *
 * `apiBaseUrl` — base of the internal API. The workflow derives BOTH endpoints
 * from it: the vendor lookup it reads, and the callback it posts the verdict
 * to. Deliberately a config value and not part of the trigger input — a caller
 * that could name its own callback host could redirect a verdict, or harvest
 * the Vault secret by pointing the workflow at a host it controls.
 *
 * Must be reachable from the enclave/DON, and must require the secret below —
 * never open. (Formerly `vendorLookupUrl`, which had stopped being true: it
 * was always a base URL, and now serves two endpoints.)
 */
export type VendorMatchWorkflowConfig = {
  apiBaseUrl: string;
  /**
   * ECDSA EVM keys permitted to invoke this trigger.
   *
   * NOT optional, and not merely a hardening step: CRE refuses to activate a
   * deployment whose HTTP trigger has none —
   *   "HTTP trigger requires at least one authorized key to sign JSON-RPC
   *    requests"
   * — so an open trigger is structurally impossible, not just unwise. Public
   * keys are not secrets, so they live in the config file rather than Vault.
   */
  authorizedKeys: string[];
  /**
   * Run the comparison inside a TEE. Stated explicitly in each config file
   * rather than defaulted, so a deployment's confidentiality is auditable by
   * reading the file it was deployed with.
   */
  confidential: boolean;
};

/** Secret ID looked up via Vault DON. Never logged. */
const VENDOR_LOOKUP_SECRET_ID = "VENDOR_LOOKUP_API_KEY";

/** Sentinel for "the vendor is not on file", distinguished from a failure. */
const NOT_FOUND = Symbol.for("vendor-not-found");

/**
 * What the trigger is invoked with. `requestId` is the correlation handle the
 * verdict is posted back under (D48) — the API creates that row before
 * invoking, so a callback naming an unknown id is rejected rather than trusted.
 */
export type VendorMatchTriggerInput = VendorMatchInput & { requestId: string };

/** Headers every call to our API carries. Bearer value is the Vault secret. */
function apiHeaders(secretValue: string) {
  return {
    Authorization: { values: [`Bearer ${secretValue}`] },
    // Harmless everywhere else, required when the API is behind an ngrok
    // tunnel: without it ngrok answers browser-ish requests with an HTML
    // interstitial, and json(response) then throws on markup instead of
    // returning a verdict. Cheaper to always send than to debug once, inside
    // an enclave, with no logs in production.
    "ngrok-skip-browser-warning": { values: ["true"] },
  };
}

function lookupRequest(config: VendorMatchWorkflowConfig, vendorId: string, secretValue: string) {
  return {
    url: `${config.apiBaseUrl}/internal/vendor-lookup/${vendorId}`,
    method: "GET" as const,
    // multiHeaders, not headers — headers is deprecated (client_pb.d.ts)
    // and the real template confirms multiHeaders is what actually gets
    // sent; a plain `headers` map here would silently not authenticate.
    multiHeaders: apiHeaders(secretValue),
  };
}

/**
 * The verdict's way home (D48).
 *
 * `body` is a base64 STRING, not raw JSON and not a Uint8Array: these request
 * literals match the SDK's `RequestJson` shape (which is why partial fields
 * typecheck at all), and there `body` is declared `string` carrying base64.
 * Getting this wrong sends the API bytes it cannot parse, and the failure
 * would surface as an unexplained 400 from inside an enclave with no logs.
 */
function callbackRequest(
  config: VendorMatchWorkflowConfig,
  requestId: string,
  secretValue: string,
  result: VendorMatchResult,
) {
  const payload = JSON.stringify({ requestId, ...result });
  return {
    url: `${config.apiBaseUrl}/internal/vendor-match-result`,
    method: "POST" as const,
    multiHeaders: {
      ...apiHeaders(secretValue),
      "Content-Type": { values: ["application/json"] },
    },
    body: base64(payload),
  };
}

/**
 * Base64 without `btoa` or `Buffer` — neither is guaranteed in CRE's Javy /
 * QuickJS runtime, and `z.string().url()` already proved that assuming a
 * standard global exists there fails at deploy time, not locally (D43).
 */
function base64(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    // charAt, not [], so the result is a string rather than string|undefined
    // under noUncheckedIndexedAccess — the indices here are masked to 0-63 and
    // cannot miss.
    out +=
      alphabet.charAt((triple >> 18) & 63) +
      alphabet.charAt((triple >> 12) & 63) +
      (b1 === undefined ? "=" : alphabet.charAt((triple >> 6) & 63)) +
      (b2 === undefined ? "=" : alphabet.charAt(triple & 63));
  }
  return out;
}

/** Turns an HTTP response into the vendor record, or NOT_FOUND. Throws on failure. */
function readVendor(response: HttpResponse): VendorRecord | typeof NOT_FOUND {
  if (response.statusCode === 404) return NOT_FOUND;

  if (!ok(response)) {
    // A lookup failure is not a match failure — the caller (the decision
    // engine) must not silently treat "we could not check" as "we checked
    // and it failed." Throwing here surfaces as a workflow error, not a
    // false verdict.
    throw new Error(`vendor lookup failed with status ${response.statusCode}`);
  }

  return json(response) as VendorRecord;
}

function verdict(
  input: VendorMatchInput,
  vendor: VendorRecord | typeof NOT_FOUND,
): VendorMatchResult {
  return vendor === NOT_FOUND
    ? { match: false, reasonCode: MATCH_REASONS.VENDOR_NOT_FOUND }
    : evaluateMatch(input, vendor);
}

/**
 * The confidential portion. Everything in this function body — the fetched
 * vendor record, the secret used to authenticate the fetch, and every
 * intermediate value — stays inside the enclave. Only the object this
 * function returns crosses out, as the workflow's result for this trigger.
 *
 * VERIFIED shapes used here (cre-sdk 1.20.0 dist/sdk/runtime.d.ts,
 * dist/generated-sdk/capabilities/networking/http/v1alpha/client_sdk_gen.d.ts):
 *   - runtime.getSecret(request): { result: () => Secret }        — NOT awaited, call .result()
 *   - httpClient.sendRequest(runtime, input): { result: () => Response } — same pattern
 *   - TeeRuntime extends BaseRuntime + SecretsProvider; has usingTheDons()
 *     to obtain a DON-routed Runtime for anything that must leave the
 *     enclave through consensus (an on-chain report, for example). This
 *     workflow does not need that: the verdict leaves via the callback below,
 *     which is itself an ordinary enclave-side HTTP call.
 *
 * The callback is what makes the workflow usable at all (D48) — the handler's
 * return value cannot be read back by the caller. Exactly one callback is sent
 * in this mode, since there is one enclave execution.
 */
function matchVendorInTee(
  runtime: TeeRuntime<VendorMatchWorkflowConfig>,
  input: VendorMatchTriggerInput,
): VendorMatchResult {
  const secret = runtime.getSecret({ id: VENDOR_LOOKUP_SECRET_ID }).result();
  const httpClient = new cre.capabilities.HTTPClient();

  const response = httpClient
    .sendRequest(runtime, lookupRequest(runtime.config, input.vendorId, secret.value))
    .result();

  const result = verdict(input, readVendor(response));

  // Only the verdict crosses out. The vendor record, the secret and every
  // intermediate value stay in the enclave — this single call is the whole
  // confidentiality boundary in practice.
  const ack = httpClient
    .sendRequest(runtime, callbackRequest(runtime.config, input.requestId, secret.value, result))
    .result();

  if (!ok(ack)) {
    // The verdict exists but never reached the caller, who is blocked awaiting
    // it. Failing loudly here is what turns that into a visible workflow error
    // instead of a request that hangs until it times out.
    throw new Error(`verdict callback failed with status ${ack.statusCode}`);
  }

  return result;
}

/**
 * The DON-mode portion. Structurally different from the TEE path, and not by
 * choice: on a plain `Runtime` the HTTP capability takes a *function* plus a
 * consensus aggregation rather than a request object, because every node
 * performs the fetch independently and the results must be reconciled
 * (client_sdk_gen.d.ts, the third sendRequest overload).
 *
 * Each node therefore fetches AND evaluates, returning the finished verdict;
 * consensusIdenticalAggregation then requires the nodes to agree exactly. That
 * is the correct strictness here — a vendor's registered wallets are not a
 * fluctuating quantity like a price, so nodes disagreeing means something is
 * wrong and no verdict should be issued.
 *
 * Confidentiality is genuinely weaker in this mode: the vendor record is
 * visible to each node that fetches it. That is the entire cost of running
 * without the TEE entitlement, and it is why this is not the default.
 *
 * The verdict callback (D48) is sent from INSIDE the node function, because
 * that is the only place a plain Runtime can make an HTTP call at all. So each
 * observing node posts the same verdict and the callback endpoint receives N
 * of them for one logical answer — which is why that endpoint is idempotent by
 * construction, not as a nicety.
 */
function matchVendorOnDon(
  runtime: Runtime<VendorMatchWorkflowConfig>,
  input: VendorMatchTriggerInput,
): VendorMatchResult {
  const secret = runtime.getSecret({ id: VENDOR_LOOKUP_SECRET_ID }).result();
  const httpClient = new cre.capabilities.HTTPClient();

  return httpClient.sendRequest(
    runtime,
    (sendRequester): VendorMatchResult => {
      const response = sendRequester
        .sendRequest(lookupRequest(runtime.config, input.vendorId, secret.value))
        .result();

      const result = verdict(input, readVendor(response));

      const ack = sendRequester
        .sendRequest(callbackRequest(runtime.config, input.requestId, secret.value, result))
        .result();

      if (!ok(ack)) {
        throw new Error(`verdict callback failed with status ${ack.statusCode}`);
      }

      return result;
    },
    consensusIdenticalAggregation<VendorMatchResult>(),
  )().result();
}

/**
 * HTTP-triggered handler registration.
 *
 * VERIFIED (cre-sdk dist/generated-sdk/capabilities/networking/http/v1alpha/
 * http_sdk_gen.d.ts): `cre.capabilities.HTTPCapability().trigger(config)`
 * returns an HTTPTrigger; its handler receives a `Payload` whose `input`
 * field is the raw request body as bytes (`Uint8Array`), which the workflow
 * must JSON-decode itself.
 *
 * `authorizedKeys` restricts which signed callers may invoke this trigger.
 * The scheme was unknown from the SDK's types alone; the deploy attempt
 * answered it. Registration is REJECTED without at least one key, so the
 * platform enforces what would otherwise have been a "harden later" item.
 * Shape: { type: "KEY_TYPE_ECDSA_EVM", publicKey: "0x..." }.
 */
export function vendorMatchHandler(config: VendorMatchWorkflowConfig) {
  const httpCapability = new cre.capabilities.HTTPCapability();
  const trigger = httpCapability.trigger({
    authorizedKeys: config.authorizedKeys.map((publicKey) => ({
      type: "KEY_TYPE_ECDSA_EVM" as const,
      publicKey,
    })),
  });

  const decode = (triggerOutput: { input: Uint8Array }) =>
    JSON.parse(new TextDecoder().decode(triggerOutput.input)) as VendorMatchTriggerInput;

  if (!config.confidential) {
    return cre.handler(trigger, (runtime: Runtime<VendorMatchWorkflowConfig>, triggerOutput) =>
      matchVendorOnDon(runtime, decode(triggerOutput)),
    );
  }

  return cre.handlerInTee(
    trigger,
    (runtime: TeeRuntime<VendorMatchWorkflowConfig>, triggerOutput) =>
      matchVendorInTee(runtime, decode(triggerOutput)),
    [{ tee: "nitro", regions: ["us-west-2"] }], // the only TEE/region combination currently available
  );
}

// Matches Runner.run's expected shape exactly (cre-sdk dist/sdk/wasm/runner.d.ts):
//   run(initFn: (config: TConfig, secretsProvider: SecretsProvider) =>
//       Promise<Workflow<TConfig>> | Workflow<TConfig>)
// secretsProvider is unused here — this workflow's only secret fetch happens
// inside the handler via runtime.getSecret, not at init time.
export function initWorkflow(config: VendorMatchWorkflowConfig) {
  return [vendorMatchHandler(config)];
}
