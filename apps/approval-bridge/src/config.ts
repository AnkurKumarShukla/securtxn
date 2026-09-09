// Bridge configuration.
//
// Runs on the APPROVER'S machine, so this reads a local .env, not the API's.
// The only secret it needs is a role-scoped bearer token — and, for the `local`
// transport, the path to an encrypted keystore. Never a bare private key: a key
// in an env file is one screenshot away from disclosure (D32).
//
// Spec: docs/architecture.md §4.3

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const Transport = z.enum(["mock", "local", "usb", "speculos"]);
export type Transport = z.infer<typeof Transport>;

const Schema = z.object({
  API_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  /** Approver- or bridge-scoped. An agent token is rejected by the API (D12). */
  BRIDGE_TOKEN: z.string().min(1).optional(),
  WALLET_CLI_TRANSPORT: Transport.default("mock"),

  /** `local` transport only. */
  KEYSTORE_PATH: z.string().optional(),
  SEPOLIA_RPC_URL: z.string().url().optional(),

  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
});

export type BridgeConfig = z.infer<typeof Schema>;

export function loadBridgeConfig(): BridgeConfig {
  loadNearestEnv();
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid bridge configuration:\n${issues}`);
  }
  return parsed.data;
}

function loadNearestEnv(startDir = process.cwd()): void {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
