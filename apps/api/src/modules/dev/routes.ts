// Local development helpers. Registered only when NODE_ENV !== production —
// see server.ts. There is no flag to turn these on in production; the guard is
// the absence of the registration, not a boolean someone can flip.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Role } from "@cp/shared-types";
import { z } from "zod";
import { MockIdentityProvider } from "../identity/providers/MockIdentityProvider.js";
import { BadRequestError } from "../../lib/errors.js";

const TokenRequest = z.object({
  role: Role,
  subject: z.string().min(1).default("local-dev"),
});

const TokenResponse = z.object({
  token: z.string(),
  role: Role,
  expiresIn: z.string(),
});

export const devRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/dev/token",
    {
      schema: {
        tags: ["dev"],
        summary: "Mint a role-scoped token for testing",
        description:
          "Returns a JWT signed with that role's secret. Paste it into the " +
          "Authorize dialog to call protected endpoints. Minting an 'agent' token " +
          "and calling an approver route is the quickest way to see the role " +
          "separation reject you.",
        body: TokenRequest,
        response: { 200: TokenResponse },
      },
    },
    async (request) => {
      const { role, subject } = request.body;
      return {
        token: await app.signToken(role, subject),
        role,
        expiresIn: "12h",
      };
    },
  );

  /**
   * Stand-in for the DigiLocker consent screen.
   *
   * Served by the API rather than apps/web so the identity flow is complete
   * without a frontend: this page is what a session's authorizationUrl points
   * at in mock mode. When apps/web exists it can render its own version and
   * call this endpoint — the state machine is the same either way.
   *
   * Visiting it is the mocked human step, and it is the ONLY way a mock session
   * reaches "succeeded". Mock mode must never short-circuit there, or bugs in
   * the polling path go undetected until the single live run (D17).
   */
  app.get(
    "/dev/identity/consent",
    {
      schema: {
        tags: ["dev"],
        summary: "Mock DigiLocker consent screen — grants consent for a session",
        querystring: z.object({ session_id: z.string().min(1) }),
        response: { 200: z.string() },
      },
    },
    async (request, reply) => {
      const provider = app.container.identityProvider;
      if (!(provider instanceof MockIdentityProvider)) {
        // Consent for a real session happens at DigiLocker, not here.
        throw new BadRequestError(
          "Consent stub is only available when IDENTITY_PROVIDER=mock",
        );
      }

      const { session_id: sessionId } = request.query;
      provider.grantConsent(sessionId);

      return reply.type("text/html").send(
        `<!doctype html><meta charset="utf-8"><title>Consent granted</title>` +
          `<body style="font:16px system-ui;max-width:34rem;margin:4rem auto">` +
          `<h1>Consent granted</h1>` +
          `<p>Session <code>${escapeHtml(sessionId)}</code> is now <strong>succeeded</strong>.</p>` +
          `<p>This stands in for the DigiLocker consent screen. The real one is ` +
          `PKCE-protected and cannot be automated.</p>` +
          `<p>Next: <code>POST /vendors/:id/identity/complete</code>.</p></body>`,
      );
    },
  );
};

/** The session id is echoed into HTML; it is caller-supplied, so escape it. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c] ?? c;
  });
}
