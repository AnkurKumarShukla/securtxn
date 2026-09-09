// Fastify instance assembly. Plugin order matters and is the reason this is one
// linear file rather than an auto-loader: rate limiting must exist before the
// error handler registers its 404 route, and config must exist before anything
// that reads a secret.
//
// This process is read-and-propose only. It must never gain a code path that
// can invoke a signing key — that lives in apps/approval-bridge (D12).
//
// Spec: docs/architecture.md §4.1

import { randomUUID } from "node:crypto";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { loadConfig, type Config } from "./config/index.js";
import containerPlugin from "./container.js";
import { buildLoggerOptions } from "./lib/logger.js";
import httpsEnforcementPlugin, { tlsServerOptions } from "./lib/tls.js";
import { devRoutes } from "./modules/dev/routes.js";
import { identityRoutes } from "./modules/identity/routes.js";
import { vendorRoutes } from "./modules/vendors/routes.js";
import { walletRoutes } from "./modules/wallets/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { evidenceRoutes } from "./modules/evidence/routes.js";
import { exceptionRoutes } from "./modules/exceptions/routes.js";
import { approvalRoutes } from "./modules/approvals/routes.js";
import { identityRegistryRoutes } from "./modules/internal/identity-registry.routes.js";
import { vendorLookupRoutes } from "./modules/internal/vendor-lookup.routes.js";
import { vendorMatchResultRoutes } from "./modules/internal/vendor-match-result.routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import authPlugin from "./plugins/auth.js";
import configPlugin from "./plugins/config.js";
import errorHandlerPlugin from "./plugins/error-handler.js";
import prismaPlugin from "./plugins/prisma.js";
import swaggerPlugin from "./plugins/swagger.js";

export async function buildServer(config: Config = loadConfig()): Promise<FastifyInstance> {
  const tls = tlsServerOptions(config);

  const app = Fastify({
    logger: buildLoggerOptions(config),
    ...(tls.https ? { https: tls.https } : {}),
    // Correlates every log line and error body with one request.
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    requestIdHeader: "x-request-id",
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Only when a proxy is actually in front (TLS_MODE=terminated). Otherwise a
    // client could set its own X-Forwarded-For and defeat rate limiting.
    trustProxy: tls.trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod both validates requests and generates the OpenAPI schema, so the docs
  // describe what the code actually enforces.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(configPlugin, { config });
  await app.register(httpsEnforcementPlugin);

  await app.register(fastifyHelmet, {
    // HSTS only where the connection is actually encrypted. Sending it over
    // plain HTTP in local development would pin a browser to https://localhost
    // and break every other project on that origin.
    hsts: config.TLS_MODE !== "off",
    // The API serves JSON; the only HTML it returns is the Swagger UI page,
    // which needs inline styles and scripts to render.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "validator.swagger.io"],
      },
    },
  });

  await app.register(fastifyCors, {
    // An explicit allowlist, never "*". Requests carry bearer tokens, and a
    // wildcard origin with credentials is refused by browsers anyway.
    origin: config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    maxAge: 86_400,
  });

  await app.register(fastifyRateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Per-token where authenticated, per-IP otherwise — so one noisy client
    // cannot exhaust the budget for everyone behind the same NAT.
    keyGenerator: (request) => request.auth?.sub ?? request.ip,
    // In-memory store. Single process only; a multi-instance deployment needs
    // the Redis store or the limit is per-instance.
    addHeadersOnExceeding: { "x-ratelimit-remaining": true },
  });

  await app.register(errorHandlerPlugin);
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(containerPlugin);
  await app.register(swaggerPlugin);

  await app.register(healthRoutes);

  // Absent in production rather than disabled — a token minting endpoint should
  // not be one env var away from being reachable.
  if (!config.isProduction) {
    await app.register(devRoutes);
  }

  await app.register(vendorRoutes);
  await app.register(walletRoutes);
  await app.register(identityRoutes);
  await app.register(paymentRoutes);
  await app.register(evidenceRoutes);
  await app.register(exceptionRoutes);
  await app.register(approvalRoutes);
  await app.register(identityRegistryRoutes);
  await app.register(vendorLookupRoutes);
  await app.register(vendorMatchResultRoutes);


  // Deliberately not calling app.ready() here: listen() readies it, and leaving
  // it unready keeps buildServer usable in tests that register a route first.
  return app;
}
