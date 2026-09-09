// OpenAPI generation + the browsable UI at /swagger.
//
// Schemas come from the Zod schemas the routes already validate against, so the
// docs cannot drift from the implementation — there is no second description of
// a request shape to keep in sync.
// Spec: docs/architecture.md §4.1

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

export const DOCS_ROUTE = "/swagger";

async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  if (!app.config.ENABLE_DOCS) {
    app.log.info("API docs disabled (ENABLE_DOCS=false)");
    return;
  }

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Confirmed Payee API",
        description:
          "Control layer for stablecoin B2B payments: beneficiary verification, " +
          "hardware-gated approval, and a post-send exception desk. " +
          "See docs/architecture.md for the full spec.",
        version: "0.1.0",
      },
      servers: [{ url: `http://localhost:${app.config.PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "Role-scoped token. Mint one from POST /dev/token in non-production, " +
              "then paste it here. Each role verifies against its own secret, so an " +
              "agent token is rejected on approver routes.",
          },
        },
      },
      tags: [
        { name: "health", description: "Liveness and readiness" },
        { name: "dev", description: "Local development helpers — not registered in production" },
        { name: "vendors", description: "Vendor registry and wallet versioning" },
        { name: "identity", description: "DigiLocker / KYC provider flow" },
        { name: "payments", description: "Payment requests, decisions and proposals" },
        { name: "approvals", description: "Approval queue — approver role only" },
        { name: "exceptions", description: "Exception desk" },
        { name: "evidence", description: "Hash-chained evidence records" },
        { name: "internal", description: "Machine-to-machine hooks consumed by on-chain compliance" },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: DOCS_ROUTE,
    uiConfig: { docExpansion: "list", deepLinking: true, persistAuthorization: true },
  });

  app.log.info(`API docs on http://localhost:${app.config.PORT}${DOCS_ROUTE}`);
}

export default fp(swaggerPlugin, { name: "swagger", dependencies: ["config"] });
