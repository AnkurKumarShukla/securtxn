// Logger configuration with PII redaction applied at the serializer level, so a
// field cannot leak by being logged accidentally somewhere else.
// Spec: docs/architecture.md §5

import type { FastifyServerOptions } from "fastify";
import type { Config } from "../config/index.js";

/**
 * Redaction is structural, not string matching. pino only walks the paths given
 * here, so anything logged under a *different* shape is still exposed — the
 * rule remains "never log a raw document or profile object", and this is the
 * backstop for the common cases.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['x-api-secret']",
  "res.headers['set-cookie']",
  // DigiLocker / KYC payloads (§4.7)
  "*.aadhaar",
  "*.uid",
  "*.pan",
  "*.panNumber",
  "*.mobile",
  "*.verifiedPhone",
  "*.dob",
  "*.dateOfBirth",
  "*.photoBase64",
  "*.address",
  "*.access_token",
  "*.signature",
  "*.controlProofSig",
  "*.attestationSig",
];

type LoggerOptions = NonNullable<FastifyServerOptions["logger"]>;

export function buildLoggerOptions(config: Config): LoggerOptions {
  if (config.NODE_ENV === "test") return false;

  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    // Pretty output in development only; production stays as JSON lines so a
    // log shipper can parse it.
    ...(config.isProduction
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }),
    serializers: {
      req(request: { method: string; url: string; id: string }) {
        // Query strings can carry identifiers; log the path only.
        const [path] = request.url.split("?");
        return { id: request.id, method: request.method, path };
      },
    },
  };
}

export { REDACT_PATHS };
