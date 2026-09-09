import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EnvSchema, loadConfig, type Config } from "../src/config/index.js";
import { buildServer } from "../src/server.js";

// Requires the local Postgres container: the prisma plugin connects at boot by
// design, so "the server starts" and "the database is reachable" are one fact.
let app: FastifyInstance;

beforeAll(async () => {
  const config: Config = { ...loadConfig(), NODE_ENV: "test", isProduction: false };
  app = await buildServer(config);
});

afterAll(async () => {
  await app?.close();
});

describe("config validation", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    HMAC_PEPPER: "a".repeat(64),
    PII_ENCRYPTION_KEY: "b".repeat(64),
    JWT_AGENT_SECRET: "1".repeat(32),
    JWT_APPROVER_SECRET: "2".repeat(32),
    JWT_BRIDGE_SECRET: "3".repeat(32),
  };

  it("accepts a well-formed environment", () => {
    expect(EnvSchema.safeParse(base).success).toBe(true);
  });

  it("rejects the API key pasted into the secret slot", () => {
    // The exact mistake this repo already made once: both Sandbox values set to
    // the key. It surfaces live as an opaque 401, hours later.
    const result = EnvSchema.safeParse({ ...base, SANDBOX_LIVE_SECRET: "key_live_abc123" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["SANDBOX_LIVE_SECRET"]);
    }
  });

  it("rejects shared role secrets", () => {
    // Identical secrets would let an agent token verify on approver routes,
    // collapsing the role separation into decoration (D12).
    const shared = { ...base, JWT_APPROVER_SECRET: base.JWT_AGENT_SECRET };
    expect(EnvSchema.safeParse(shared).success).toBe(false);
  });

  it("requires DigiLocker credentials when that provider is selected", () => {
    const result = EnvSchema.safeParse({ ...base, IDENTITY_PROVIDER: "digilocker" });
    expect(result.success).toBe(false);
  });

  it("refuses to expose docs in production", () => {
    const result = EnvSchema.safeParse({ ...base, NODE_ENV: "production", ENABLE_DOCS: "true" });
    expect(result.success).toBe(false);
  });
});

describe("health", () => {
  it("reports liveness", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("reports readiness with a database check", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { database: "up" } });
  });
});

describe("errors", () => {
  it("returns a structured 404 carrying the request id", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBeTruthy();
  });

  it("rejects a body that fails schema validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/dev/token",
      payload: { role: "not-a-role" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("role separation (D12)", () => {
  // Its own instance, because the guarded route must be registered before the
  // server is ready. The real /approvals/* routes arrive in A7.
  let roleApp: FastifyInstance;

  beforeAll(async () => {
    const config: Config = { ...loadConfig(), NODE_ENV: "test", isProduction: false };
    roleApp = await buildServer(config);
    roleApp.get("/test/approver-only", { preHandler: roleApp.requireRole("approver") }, async () => ({
      ok: true,
    }));
    await roleApp.ready();
  });

  afterAll(async () => {
    await roleApp?.close();
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await roleApp.inject({ method: "GET", url: "/test/approver-only" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an agent token on an approver route", async () => {
    const token = await roleApp.signToken("agent", "test-agent");
    const res = await roleApp.inject({
      method: "GET",
      url: "/test/approver-only",
      headers: { authorization: `Bearer ${token}` },
    });
    // 401, not 403: the agent secret cannot even produce a valid signature for
    // the approver verifier. The separation holds at the crypto layer, not at a
    // string comparison.
    expect(res.statusCode).toBe(401);
  });

  it("accepts an approver token", async () => {
    const token = await roleApp.signToken("approver", "test-approver");
    const res = await roleApp.inject({
      method: "GET",
      url: "/test/approver-only",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("openapi document", () => {
  it("describes the registered routes and the bearer scheme", async () => {
    const res = await app.inject({ method: "GET", url: "/swagger/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(Object.keys(doc.paths)).toContain("/health");
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
  });
});

describe("TLS configuration (§5)", () => {
  const baseEnv = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    HMAC_PEPPER: "a".repeat(64),
    PII_ENCRYPTION_KEY: "b".repeat(64),
    JWT_AGENT_SECRET: "1".repeat(32),
    JWT_APPROVER_SECRET: "2".repeat(32),
    JWT_BRIDGE_SECRET: "3".repeat(32),
    ENABLE_DOCS: "false",
  };

  it("defaults to off for local development", () => {
    expect(EnvSchema.parse(baseEnv).TLS_MODE).toBe("off");
  });

  it("refuses plaintext in production", () => {
    // The bridge acts on what this API sends. Serving that in the clear lets
    // anyone on the path choose the recipient a human is asked to confirm.
    const result = EnvSchema.safeParse({ ...baseEnv, NODE_ENV: "production", TLS_MODE: "off" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("TLS_MODE"))).toBe(true);
    }
  });

  it("accepts a terminating proxy in production", () => {
    expect(
      EnvSchema.safeParse({ ...baseEnv, NODE_ENV: "production", TLS_MODE: "terminated" }).success,
    ).toBe(true);
  });

  it("requires a certificate and key for direct mode", () => {
    expect(EnvSchema.safeParse({ ...baseEnv, TLS_MODE: "direct" }).success).toBe(false);
    expect(
      EnvSchema.safeParse({
        ...baseEnv,
        TLS_MODE: "direct",
        TLS_CERT_PATH: "/tmp/cert.pem",
        TLS_KEY_PATH: "/tmp/key.pem",
      }).success,
    ).toBe(true);
  });

  it("trusts forwarded headers only behind a proxy", async () => {
    // Trusting x-forwarded-* with nothing in front would let a client spoof its
    // own IP past rate limiting and claim an encrypted connection it lacks.
    const { tlsServerOptions } = await import("../src/lib/tls.js");
    const config = loadConfig();
    expect(tlsServerOptions({ ...config, TLS_MODE: "off" }).trustProxy).toBe(false);
    expect(tlsServerOptions({ ...config, TLS_MODE: "terminated" }).trustProxy).toBe(true);
  });

  it("rejects a request that reached the proxy in the clear", async () => {
    const config: Config = {
      ...loadConfig(),
      NODE_ENV: "test",
      isProduction: false,
      RATE_LIMIT_MAX: 1_000_000,
      TLS_MODE: "terminated",
    };
    const proxied = await buildServer(config);
    await proxied.ready();

    const insecure = await proxied.inject({
      method: "GET",
      url: "/swagger/json",
      headers: { "x-forwarded-proto": "http" },
    });
    // 426 rather than a redirect: silently redirecting a POST drops its body.
    expect(insecure.statusCode).toBe(426);

    const secure = await proxied.inject({
      method: "GET",
      url: "/swagger/json",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(secure.statusCode).toBe(200);

    // Health probes stay reachable, or an internal check reads as an outage.
    const health = await proxied.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-proto": "http" },
    });
    expect(health.statusCode).toBe(200);

    await proxied.close();
  });
});
