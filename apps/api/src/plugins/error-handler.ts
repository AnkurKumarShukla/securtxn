// The single place an error becomes an HTTP response. Routes throw; nothing
// else formats an error body.
// Spec: docs/architecture.md §4.1

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError } from "../lib/errors.js";

/**
 * Our own error vocabulary, keyed by status. Preferred over Fastify's internal
 * `FST_ERR_*` codes, which name library internals rather than something a
 * client can act on.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  406: "NOT_ACCEPTABLE",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
};

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
};

function body(code: string, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler(
    // Rate-limit 404s too: an unauthenticated prober should not get a free
    // endpoint-enumeration channel.
    { preHandler: app.rateLimit() },
    (request, reply) => {
      reply.status(404).send(body("NOT_FOUND", `Route ${request.method} ${request.url} not found`, request.id));
    },
  );

  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    // Request body/params failed Zod validation → the caller can fix this.
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error }, "request validation failed");
      return reply.status(400).send(
        body(
          "VALIDATION_ERROR",
          "Request does not match the expected schema",
          request.id,
          error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        ),
      );
    }

    // We produced a response that does not match our own declared schema. That
    // is our bug, and it must never surface as a partially-correct 200.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, "response serialization failed");
      return reply.status(500).send(body("INTERNAL_ERROR", "Internal server error", request.id));
    }

    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? "error" : "info";
      request.log[level]({ err: error, code: error.code }, error.message);
      return reply
        .status(error.statusCode)
        .send(body(error.code, error.message, request.id, error.details));
    }

    // Fastify's own errors (rate limit, body too large, malformed JSON) carry a
    // usable statusCode. Anything 4xx is safe to echo; 5xx is not.
    const fastifyError = error as FastifyError;
    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode < 500) {
      request.log.info({ err: error }, "client error");
      const code = CODE_BY_STATUS[statusCode] ?? fastifyError.code ?? "BAD_REQUEST";
      return reply.status(statusCode).send(body(code, fastifyError.message, request.id));
    }

    // Unknown server-side failure: log everything, return nothing specific.
    // Stack traces and driver messages leak schema and file paths.
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(body("INTERNAL_ERROR", "Internal server error", request.id));
  });
}

export default fp(errorHandlerPlugin, { name: "error-handler", dependencies: ["@fastify/rate-limit"] });
