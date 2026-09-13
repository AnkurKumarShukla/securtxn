// Mints a role-scoped token with an explicit lifetime.
//
// WHY THIS EXISTS SEPARATELY FROM /dev/token. That endpoint issues the normal
// 12-hour token and is not registered in production at all, so it cannot mint
// anything for a deployed instance. The CRE workflow authenticates to the
// vendor-lookup endpoint with a token held in the Vault DON, and a 12-hour one
// means the enclave stops working overnight — which is precisely when nobody is
// watching.
//
// THE TRADE-OFF, STATED PLAINLY. A long-lived agent token is a standing
// credential: anyone who obtains it can read vendor digests until it expires or
// the signing secret is rotated. That is acceptable for a judged demo window and
// not acceptable as a permanent posture. Rotate JWT_AGENT_SECRET when the window
// closes — that invalidates every token signed with it, including this one.
//
//   pnpm --filter @cp/api mint:token -- --role agent --subject cre-vendor-lookup --ttl 7d
//
// Signed with the same secret the deployed API verifies with, so the token works
// against any instance sharing that secret.

import jwt from "jsonwebtoken";
import { loadConfig } from "../src/config/index.js";

type Role = "agent" | "approver" | "bridge" | "issuer";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value && fallback === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value ?? fallback!;
}

const role = arg("role", "agent") as Role;
const subject = arg("subject", "cre-vendor-lookup");
const ttl = arg("ttl", "7d");

const config = loadConfig();

const secrets: Record<Role, string> = {
  agent: config.JWT_AGENT_SECRET,
  approver: config.JWT_APPROVER_SECRET,
  bridge: config.JWT_BRIDGE_SECRET,
  issuer: config.JWT_ISSUER_SECRET,
};

const secret = secrets[role];
if (!secret) throw new Error(`no signing secret configured for role '${role}'`);

// The payload shape the auth plugin verifies: { sub, role }.
const token = jwt.sign({ sub: subject, role }, secret, { expiresIn: ttl });

const decoded = jwt.decode(token) as { exp: number; iat: number };
const expires = new Date(decoded.exp * 1000);
const days = ((decoded.exp - decoded.iat) / 86_400).toFixed(1);

console.log(`role    : ${role}`);
console.log(`subject : ${subject}`);
console.log(`ttl     : ${ttl}  (${days} days)`);
console.log(`expires : ${expires.toISOString()}`);
console.log(`\n${token}\n`);
console.log("Next, for the CRE lookup secret:");
console.log("  1. put it in .env as SECRET_VENDOR_LOOKUP_API_KEY");
console.log("  2. cd packages/cre-workflows");
console.log("  3. cre secrets update secrets.yaml --secrets-auth browser -e ../../.env");
console.log("\nRotate JWT_AGENT_SECRET when the demo window closes; that revokes this.");
