// Mints the role-scoped token the console calls the API with.
//
// WHY THIS EXISTS. The console used to call `POST /dev/token` on the API. That
// route is registered only when NODE_ENV !== production (apps/api/src/server.ts),
// deliberately — "a token minting endpoint should not be one env var away from
// being reachable" — so on the first production deploy every authenticated
// action in the app died with:
//
//     could not mint an approver token: Route POST /dev/token not found
//
// The fix is not to register that route in production. An approver token is
// what stands between a payment and a human agreeing to it; handing one out
// from the open API would make the approval gate decoration. So the minting
// moves here, to the web app's own server, where:
//
//   - the JWT secrets are held by this process and never enter the client
//     bundle (only NEXT_PUBLIC_* is exposed, and these are not that);
//   - only the two roles the UI actually uses can be minted. `issuer` signs
//     credentials and `bridge` moves money; neither is ever needed by a
//     browser, so neither is reachable from one.
//
// THE LIMIT, STATED PLAINLY. This app has no user authentication, so anyone who
// can load the page can still obtain a token — that was equally true of
// /dev/token. What this changes is that the API no longer hands arbitrary role
// tokens to the open internet, and the blast radius is capped at the two roles
// the console uses. A real fix is a login, which this is not.
//
// The same path runs locally and in production, so the dev/prod divergence that
// produced the original failure is gone rather than moved.

import { createHmac } from "node:crypto";

export const runtime = "nodejs"; // node crypto, not the edge runtime
export const dynamic = "force-dynamic"; // every token is freshly signed

/**
 * Mintable from a browser. NOT the full Role union on purpose — see above.
 * Keyed by the env var holding each role's secret, so adding a role here
 * without adding its secret is a type error rather than a runtime 500.
 */
const MINTABLE = {
  agent: "JWT_AGENT_SECRET",
  approver: "JWT_APPROVER_SECRET",
} as const;

type MintableRole = keyof typeof MINTABLE;

/** Matches apps/api/src/plugins/auth.ts — the API rejects anything longer. */
const TTL_SECONDS = 12 * 60 * 60;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/**
 * An HS256 JWT in the exact shape @fastify/jwt verifies.
 *
 * Hand-rolled rather than pulling in a signing library: the payload the API
 * checks is two claims, and a new dependency means a lockfile change on a
 * deployment that installs with --frozen-lockfile.
 */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: issuedAt, exp: issuedAt + TTL_SECONDS };

  const signingInput = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(body),
  )}`;

  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export async function POST(request: Request): Promise<Response> {
  let role: string;
  let subject: string;
  try {
    const body = (await request.json()) as { role?: string; subject?: string };
    role = body.role ?? "";
    subject = body.subject ?? "securtxn-web";
  } catch {
    return Response.json({ error: "expected a JSON body with a `role`" }, { status: 400 });
  }

  if (!(role in MINTABLE)) {
    // Names the roles that ARE available rather than only refusing, because the
    // caller is our own console and a silent 400 here reads as a network fault.
    return Response.json(
      { error: `role must be one of: ${Object.keys(MINTABLE).join(", ")}` },
      { status: 400 },
    );
  }

  const secret = process.env[MINTABLE[role as MintableRole]];
  if (!secret) {
    // Loud, and without naming the variable's value. A missing secret here
    // would otherwise surface as a 401 from the API much later, where it looks
    // like a rejected token rather than an unconfigured service.
    return Response.json(
      { error: `${MINTABLE[role as MintableRole]} is not configured on the server` },
      { status: 500 },
    );
  }

  // The payload the API's requireRole reads: { sub, role }.
  const token = signJwt({ sub: subject, role }, secret);

  return Response.json({ token, role, expiresIn: "12h" });
}
