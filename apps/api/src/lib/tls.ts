// TLS setup.
//
// Three deployment shapes, one codebase (§5):
//
//   off        plain HTTP — local development only, refused in production
//   terminated a proxy or load balancer terminates TLS; this process trusts
//              x-forwarded-proto and rejects anything that arrived in the clear
//   direct     this process serves HTTPS itself, TLS 1.3 minimum
//
// WHY THIS MATTERS MORE THAN USUAL: apps/approval-bridge holds the only signing
// key, and it acts on what this API tells it — it prints a recipient and an
// amount for a human to confirm. Anyone able to sit on that connection chooses
// what the operator sees, and therefore where the money goes. The human
// confirmation step is only as trustworthy as the channel that fed it.
//
// Spec: docs/architecture.md §5

import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config/index.js";

export type TlsServerOptions = {
  https?: {
    key: Buffer;
    cert: Buffer;
    ca?: Buffer;
    minVersion: "TLSv1.3";
  };
  trustProxy: boolean;
};

/**
 * Server options for the configured mode.
 *
 * `trustProxy` is enabled ONLY in terminated mode. Trusting forwarded headers
 * when nothing is in front of the process would let a client set its own
 * `x-forwarded-for` and `x-forwarded-proto` — spoofing its IP past rate
 * limiting, and claiming an encrypted connection it does not have.
 */
export function tlsServerOptions(config: Config): TlsServerOptions {
  if (config.TLS_MODE === "direct") {
    return {
      https: {
        key: readFileSync(config.TLS_KEY_PATH!),
        cert: readFileSync(config.TLS_CERT_PATH!),
        ...(config.TLS_CA_PATH ? { ca: readFileSync(config.TLS_CA_PATH) } : {}),
        // TLS 1.3 only. 1.2 is still widely accepted elsewhere, but there is no
        // legacy client here — the callers are our own bridge and browser.
        minVersion: "TLSv1.3" as const,
      },
      trustProxy: false,
    };
  }

  return { trustProxy: config.TLS_MODE === "terminated" };
}

/**
 * Rejects plaintext requests behind a terminating proxy.
 *
 * A proxy that forwards over plain HTTP internally is normal; a request that
 * reached the PROXY in the clear is not, and the only way to tell is
 * `x-forwarded-proto`. Health checks are exempt so an infrastructure probe on
 * the internal address does not read as an outage.
 */
async function httpsEnforcementPlugin(app: FastifyInstance): Promise<void> {
  if (app.config.TLS_MODE !== "terminated") return;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/health")) return;

    const proto = request.headers["x-forwarded-proto"];
    const scheme = Array.isArray(proto) ? proto[0] : proto;
    if (scheme && scheme !== "https") {
      // 426 rather than a redirect: this is an API, and silently redirecting a
      // POST would drop its body while looking like it worked.
      return reply.status(426).send({
        error: {
          code: "UPGRADE_REQUIRED",
          message: "This API is only available over HTTPS",
          requestId: request.id,
        },
      });
    }
  });

  app.log.info("HTTPS enforcement active (TLS terminated upstream)");
}

export default fp(httpsEnforcementPlugin, { name: "https-enforcement", dependencies: ["config"] });
