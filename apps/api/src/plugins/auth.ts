// Role separation, enforced at the API layer rather than in the UI.
//
// `agent` (autonomous code) may propose payments but may not touch /approvals/*.
// `approver` may read the queue and report a completed send but may not propose.
// `bridge` is the approval-bridge daemon's own identity.
//
// Each role verifies against its OWN secret, so a token minted for one role
// cannot be replayed as another even if the payload claims otherwise — the
// signature check fails first. That is what makes the separation structural
// rather than a string comparison (D12).
//
// Spec: docs/architecture.md §4.2

import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import fp from "fastify-plugin";
import { Role } from "@cp/shared-types";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";

const TOKEN_TTL = "12h";

/** Verifier method installed on the request by each namespaced jwt registration. */
const VERIFIER = {
  agent: "agentJwtVerify",
  approver: "approverJwtVerify",
  bridge: "bridgeJwtVerify",
} as const satisfies Record<Role, string>;

export type TokenPayload = { sub: string; role: Role };

declare module "fastify" {
  interface FastifyInstance {
    /** Route guard: `preHandler: app.requireRole("agent")`. */
    requireRole(role: Role): preHandlerHookHandler;
    /**
     * Accepts any ONE of the listed roles.
     *
     * Each is still verified against its own secret — this tries them in turn
     * rather than loosening verification. Used only where two identities have a
     * genuine claim to the same endpoint, e.g. the approval queue, which both a
     * human approver and the bridge daemon read.
     */
    requireAnyRole(...roles: Role[]): preHandlerHookHandler;
    /** Mints a token for a role. Used by the dev token route and by tests. */
    signToken(role: Role, subject: string): Promise<string>;
  }
  interface FastifyRequest {
    /** Populated by requireRole once the token verifies. */
    auth?: TokenPayload;
  }
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  const secrets: Record<Role, string> = {
    agent: app.config.JWT_AGENT_SECRET,
    approver: app.config.JWT_APPROVER_SECRET,
    bridge: app.config.JWT_BRIDGE_SECRET,
  };

  for (const role of Role.options) {
    await app.register(fastifyJwt, {
      secret: secrets[role],
      namespace: role,
      jwtVerify: VERIFIER[role],
      sign: { expiresIn: TOKEN_TTL },
    });
  }

  app.decorate("requireRole", (role: Role): preHandlerHookHandler => {
    return async function verifyRole(request: FastifyRequest, _reply: FastifyReply) {
      // The namespaced verifier is installed dynamically by @fastify/jwt, so it
      // is not on the static FastifyRequest type. This cast is the only place
      // that indirection exists.
      const verify = (request as unknown as Record<string, unknown>)[VERIFIER[role]];
      if (typeof verify !== "function") {
        // The namespaced verifier is missing, which means the jwt registration
        // for this role did not happen. Fail closed rather than letting the
        // request through unauthenticated.
        throw new Error(`auth: verifier '${VERIFIER[role]}' is not registered`);
      }

      try {
        await (verify as () => Promise<unknown>).call(request);
      } catch {
        // Do not echo the jwt library's reason — it distinguishes "expired"
        // from "bad signature", which is a probing aid.
        throw new UnauthorizedError();
      }

      const payload = request.user as Partial<TokenPayload> | undefined;
      if (!payload || payload.role !== role) {
        throw new ForbiddenError(`This endpoint requires the '${role}' role`);
      }

      request.auth = { sub: payload.sub ?? "unknown", role };
    };
  });

  // A namespaced registration exposes its signer at app.jwt[namespace].sign,
  // while the verifier is installed on the request under the name given above.
  app.decorate("requireAnyRole", (...roles: Role[]): preHandlerHookHandler => {
    return async function verifyAnyRole(request: FastifyRequest, reply: FastifyReply) {
      let lastError: unknown;
      for (const role of roles) {
        try {
          await (app.requireRole(role) as (req: FastifyRequest, rep: FastifyReply) => Promise<void>)(
            request,
            reply,
          );
          return;
        } catch (err) {
          lastError = err;
        }
      }
      // Every role failed: report the last failure rather than inventing one,
      // so an expired approver token still reads as 401 and not 403.
      throw lastError ?? new UnauthorizedError();
    };
  });

  app.decorate("signToken", async (role: Role, subject: string): Promise<string> => {
    const namespaced = (app.jwt as unknown as Record<string, { sign?: (p: TokenPayload) => string }>)[role];
    if (typeof namespaced?.sign !== "function") {
      throw new Error(`auth: no jwt namespace registered for role '${role}'`);
    }
    return namespaced.sign({ sub: subject, role });
  });
}

export default fp(authPlugin, { name: "auth", dependencies: ["config"] });
