// Env parsing + validation. The process refuses to start on invalid config
// rather than failing later at the first request that needs a secret.
// Spec: docs/architecture.md §9

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { VerificationTier } from "@cp/shared-types";
import { z } from "zod";

/**
 * Loads the nearest `.env` walking up from cwd. The file lives at the repo root
 * but the process starts in `apps/api`, and the dist build runs from a
 * different depth again — so search rather than hardcode a relative path.
 */
function loadEnvFile(startDir = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return dir;
    }
    const parent = dirname(dir);
    // Reached the filesystem root: rely on real env vars, and treat cwd as the
    // project root for path resolution.
    if (parent === dir) return startDir;
    dir = parent;
  }
}

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** A tier ceiling. Zero is meaningful: TIER0 may receive nothing. */
const AmountOrZero = z
  .string()
  .regex(/^\d{1,20}(\.\d{1,18})?$/, "must be a decimal string with at most 18 decimal places");

/** 32 bytes of hex — what `crypto.randomBytes(32).toString("hex")` produces. */
const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex characters (32 bytes)");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: z.string().url(),

    // Comma-separated allowlist. Never "*" — the API is called with bearer tokens.
    CORS_ORIGINS: z.string().default("http://localhost:3001"),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

    /**
     * How TLS is provided (§5).
     *
     *   off        plain HTTP. Local development only; refused in production.
     *   terminated a load balancer or reverse proxy terminates TLS and forwards
     *              over the internal network. The app trusts x-forwarded-proto
     *              and refuses requests that arrived in the clear.
     *   direct     this process serves HTTPS itself, TLS 1.3 minimum.
     *
     * Deliberately explicit rather than inferred from NODE_ENV: "is this
     * connection encrypted" is not something to guess at.
     */
    TLS_MODE: z.enum(["off", "terminated", "direct"]).default("off"),
    TLS_CERT_PATH: z.string().optional(),
    TLS_KEY_PATH: z.string().optional(),
    /** Optional chain to serve alongside the certificate. */
    TLS_CA_PATH: z.string().optional(),
    ENABLE_DOCS: booleanish.default("true"),

    // --- secrets (§5) ---
    HMAC_PEPPER: hex32,
    PII_ENCRYPTION_KEY: hex32,
    JWT_AGENT_SECRET: z.string().min(32),
    JWT_APPROVER_SECRET: z.string().min(32),
    JWT_BRIDGE_SECRET: z.string().min(32),

    /**
     * Per-customer risk appetite: the largest payment each verification tier
     * may receive (D08). A tier omitted from this map has no ceiling.
     *
     * Parsed and validated here rather than at first use, so a malformed limit
     * is a boot failure and not a wrong decision hours later (D22).
     */
    TIER_AMOUNT_LIMITS: z
      .string()
      .default('{"TIER0_UNVERIFIED":"0","TIER1_LIVENESS":"1000","TIER2_IDENTITY":"50000"}')
      .transform((raw, ctx): Partial<Record<VerificationTier, string>> => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
          return z.NEVER;
        }
        const shape = z.record(VerificationTier, AmountOrZero).safeParse(parsed);
        if (!shape.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `keys must be VerificationTier values and amounts decimal strings (${shape.error.issues[0]?.message ?? "invalid"})`,
          });
          return z.NEVER;
        }
        return shape.data;
      }),

    /**
     * EIP-712 domain chainId. Part of what a payee signs, so it is replay
     * protection: a signature produced for one chain will not verify against
     * another. Sepolia by default.
     */
    EIP712_CHAIN_ID: z.coerce.number().int().positive().default(11155111),

    // --- swappable implementations, resolved in container.ts (D09) ---
    IDENTITY_PROVIDER: z.enum(["digilocker", "generic", "mock"]).default("mock"),
    VENDOR_MATCHER: z.enum(["fallback", "cre"]).default("fallback"),
    /**
     * On-chain compliance: "ats" writes real transactions, "mock" does not.
     *
     * Defaults to mock so that broadcasting is an explicit opt-in. Inferring it
     * from the presence of credentials meant every test process picked the real
     * chain the moment the Hedera keys were filled in.
     */
    COMPLIANCE_GATEWAY: z.enum(["ats", "mock"]).default("mock"),
    /**
     * Minimum name similarity (0-1) that counts as a vendor match. Risk
     * appetite, not a constant — set it lower and more payments reach a human
     * as REVERIFY; set it higher and fewer do (D08).
     */
    VENDOR_MATCH_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.85),

    // --- CRE vendor match (§4.4, D47/D48) ---
    // Required only when VENDOR_MATCHER=cre; the check is in container.ts so
    // selecting 'cre' with these missing fails loudly at boot rather than at
    // the first payment (D21).
    /** Tenant gateway, from `~/.cre/context.yaml`. NOT the enterprise host. */
    CRE_GATEWAY_URL: z.string().optional(),
    /** From `cre workflow deploy`. Changes with every binary or config change. */
    CRE_WORKFLOW_ID: z.string().optional(),
    /**
     * Signs the JSON-RPC invocation. Its ADDRESS must appear in the deployed
     * workflow's `authorizedKeys` or the gateway rejects the call.
     *
     * Invocation authority only: it cannot move a payout — that lives in
     * apps/approval-bridge (D12) — and it signs nothing on-chain.
     */
    CRE_CALLER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
      .optional(),
    /** Bound on awaiting the verdict callback. Observed executions settle in 4-7s. */
    CRE_MATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

    // --- World ID / Selfie Check (§4.6, B4, D49) ---
    /**
     * Selfie Check is ACCESS-GATED per app and the Portal exposes no way to read
     * that flag (see docs/world-id-feedback.md), so this is our own switch, not
     * a mirror of theirs. Off means the routes still exist but refuse — the
     * control is absent loudly rather than silently passing.
     */
    WORLD_FEATURE_FLAG_ENABLED: booleanish.default("false"),
    /** From the Developer Portal. Public identifiers, not secrets. */
    WORLD_RP_ID: z.string().optional(),
    /**
     * The action every proof must carry.
     *
     * CONSTANT BY DESIGN. The nullifier is action-scoped, so enrollment and
     * every later continuity check must use the same string or the same human
     * yields different nullifiers and continuity breaks silently — which would
     * look like fraud detection working (D49).
     */
    WORLD_ACTION: z.string().default("verify-payment-approver"),
    /** Overridable so tests never reach the live verifier. */
    WORLD_VERIFY_BASE_URL: z.string().default("https://developer.world.org/api/v4/verify"),

    // --- Hedera ATS (§4.5, D40/D42) ---
    /** 296 = Hedera testnet, 295 = mainnet. */
    HEDERA_CHAIN_ID: z.coerce.number().int().positive().default(296),
    /**
     * Signs verifiable credentials and submits grantKyc/revokeKyc.
     *
     * Holds no funds beyond gas and cannot move a payout — that authority lives
     * only in apps/approval-bridge (D12). Absent means credentials are not
     * issued, which fails closed rather than issuing unsigned ones.
     */
    ATS_ISSUER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
      .optional(),
    /** The deployed security (diamond) address KYC is granted against. */
    ATS_SECURITY_ID: z.string().optional(),
    /** Hedera account id for the issuer, e.g. "0.0.10443799". */
    ATS_ISSUER_ACCOUNT_ID: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "must be a Hedera account id like 0.0.12345")
      .optional(),
    /** JSON-RPC relay. Hedera is EVM-compatible through this, not natively. */
    HEDERA_JSON_RPC_URL: z.string().url().optional(),
    /**
     * Published per network by the ATS project; not bundled with the SDK, so
     * they have to be supplied. `setConfig` needs both before issuance.
     * Testnet values verified live via the mirror node.
     */
    ATS_FACTORY_ADDRESS: z.string().optional(),
    ATS_RESOLVER_ADDRESS: z.string().optional(),
    /** Mirror node — read-only queries for account and contract state. */
    HEDERA_MIRROR_NODE_URL: z.string().url().optional(),
    /**
     * Business-logic configuration registered on the resolver:
     * 0x..01 equity, 0x..02 bond. Passed to Bond.create as `configId`.
     */
    ATS_BOND_CONFIG_ID: z.string().optional(),
    /**
     * Empty resolves the latest registered version at submit time.
     *
     * Preprocessed because `z.coerce.number()` turns "" into 0, which then
     * fails `.positive()` — so the documented way to say "latest" would break
     * boot.
     */
    ATS_BOND_CONFIG_VERSION: z.preprocess(
      (v) => (v === "" || v === undefined ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),

    // --- DigiLocker (§4.7) ---
    SANDBOX_BASE_URL: z.string().url().default("https://api.sandbox.co.in"),
    SANDBOX_LIVE_KEY: z.string().optional(),
    SANDBOX_LIVE_SECRET: z.string().optional(),
    DIGILOCKER_REDIRECT_URL: z.string().url().optional(),
    DIGILOCKER_FIXTURE_DIR: z.string().default("./fixtures/digilocker-synthetic"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    // The live secret and the live key are different values. Pasting the key
    // into both slots is a real mistake this repo has already made once, and it
    // surfaces as an opaque 401 from the aggregator hours later.
    if (env.SANDBOX_LIVE_SECRET && !env.SANDBOX_LIVE_SECRET.startsWith("secret_live_")) {
      fail("SANDBOX_LIVE_SECRET", "must start with 'secret_live_' — not the API key");
    }
    if (env.SANDBOX_LIVE_KEY && !env.SANDBOX_LIVE_KEY.startsWith("key_live_")) {
      fail("SANDBOX_LIVE_KEY", "must start with 'key_live_'");
    }

    if (env.IDENTITY_PROVIDER === "digilocker") {
      if (!env.SANDBOX_LIVE_KEY) fail("SANDBOX_LIVE_KEY", "required when IDENTITY_PROVIDER=digilocker");
      if (!env.SANDBOX_LIVE_SECRET) fail("SANDBOX_LIVE_SECRET", "required when IDENTITY_PROVIDER=digilocker");
      if (!env.DIGILOCKER_REDIRECT_URL) {
        fail("DIGILOCKER_REDIRECT_URL", "required when IDENTITY_PROVIDER=digilocker");
      }
    }

    // Shared role secrets would collapse the agent/approver separation (D12)
    // into decoration, since either token would verify against the other.
    const roleSecrets = [env.JWT_AGENT_SECRET, env.JWT_APPROVER_SECRET, env.JWT_BRIDGE_SECRET];
    if (new Set(roleSecrets).size !== roleSecrets.length) {
      fail("JWT_AGENT_SECRET", "the three role secrets must all differ");
    }

    if (env.NODE_ENV === "production" && env.ENABLE_DOCS) {
      fail("ENABLE_DOCS", "must be false in production — docs expose the full API surface");
    }

    // The bridge holds the only signing key and acts on what this API tells it.
    // Serving that over plaintext in production would let anyone on the path
    // choose the recipient a human is asked to confirm.
    if (env.NODE_ENV === "production" && env.TLS_MODE === "off") {
      fail("TLS_MODE", "must be 'terminated' or 'direct' in production, never 'off'");
    }

    if (env.TLS_MODE === "direct") {
      if (!env.TLS_CERT_PATH) fail("TLS_CERT_PATH", "required when TLS_MODE=direct");
      if (!env.TLS_KEY_PATH) fail("TLS_KEY_PATH", "required when TLS_MODE=direct");
    }
  });

export type Config = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  corsOrigins: string[];
  /**
   * Directory holding the .env — the repo root.
   *
   * Relative paths in config (fixture directories, key files) resolve against
   * this, NOT against cwd. The process starts in apps/api under pnpm, in the
   * repo root under some editors, and somewhere else again in a container: a
   * cwd-relative path silently means three different directories.
   */
  repoRoot: string;
};

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const repoRoot = loadEnvFile();
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    // Print the offending keys and reasons only — never the values.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = {
    ...parsed.data,
    repoRoot,
    isProduction: parsed.data.NODE_ENV === "production",
    corsOrigins: parsed.data.CORS_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
  return cached;
}

/** Test helper — forces the next loadConfig() to re-read process.env. */
export function resetConfigCache(): void {
  cached = undefined;
}

export { EnvSchema };
