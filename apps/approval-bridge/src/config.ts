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

  /**
   * Extra CA certificate to trust, for a self-signed API certificate in
   * development.
   *
   * This is the correct way to trust a private certificate. Disabling
   * verification is NOT offered here at any setting: this process holds the
   * only signing key and acts on what the API tells it, so an unverified
   * connection means anyone on the path can choose the recipient a human is
   * asked to confirm.
   */
  BRIDGE_CA_CERT_PATH: z.string().optional(),

  /**
   * Permits a plaintext http:// API URL. Local development only.
   *
   * Explicit because it removes the protection above, and a flag someone had
   * to set is visible in a way a silent default is not.
   */
  BRIDGE_ALLOW_INSECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type BridgeConfig = z.infer<typeof Schema>;

export function loadBridgeConfig(): BridgeConfig {
  loadNearestEnv();
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid bridge configuration:\n${issues}`);
  }
  const config = parsed.data;

  if (config.API_BASE_URL.startsWith("http://") && !config.BRIDGE_ALLOW_INSECURE) {
    throw new Error(
      `API_BASE_URL is plaintext (${config.API_BASE_URL}). The bridge holds the signing key ` +
        "and confirms recipients from what the API sends, so an unencrypted channel lets " +
        "anyone on the path choose where money goes. Use https, or set " +
        "BRIDGE_ALLOW_INSECURE=true for local development only.",
    );
  }

  return config;
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
