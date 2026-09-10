// Workflow entrypoint. This is the file `cre workflow simulate` and
// `cre workflow deploy` actually run — everything else in this directory is
// a library import from here.
//
// Matches the reference implementation exactly: `cre init
// --template=hello-confidential-workflows-ts` generates a real project whose
// main.ts calls `Runner.newRunner({ configSchema })` with no configParser —
// the default byte-to-JSON parse is built in, and configSchema alone is
// enough. An earlier version of this file added a redundant explicit
// configParser; removed to match what CRE's own tooling actually produces
// and runs, not an assumption about what it might need.

import { Runner } from "@chainlink/cre-sdk";
import { z } from "zod";
import { initWorkflow, type VendorMatchWorkflowConfig } from "./workflow.js";

// z.string().url() FAILS unconditionally inside CRE's WASM runtime — reproduced
// against three different valid URLs, config hash changing each time to
// confirm it was genuinely re-validating fresh input, all rejected. This SDK
// ships @chainlink/cre-sdk-javy-plugin — Javy is a QuickJS-based WASM JS
// engine — and Zod 3.x's .url() validator calls the native URL constructor,
// which QuickJS is not guaranteed to implement. Testing that hypothesis by
// dropping .url() for a plain z.string() below.
const configSchema = z.object({
  apiBaseUrl: z.string(),
  // At least one — CRE rejects activation of a trigger with none.
  authorizedKeys: z.array(z.string()).min(1),
  // Required, not defaulted: a deployment's confidentiality should be legible
  // from the config file it was deployed with, not inferred from a default.
  confidential: z.boolean(),
}) satisfies z.ZodType<VendorMatchWorkflowConfig>;

export async function main() {
  const runner = await Runner.newRunner({ configSchema });
  await runner.run(initWorkflow);
}

await main();
