// Shared World ID config for the test surface (B4, §4.6).
//
// Two halves, deliberately separated:
//   - PUBLIC values (app_id, rp_id, action, environment, preset) are safe in the
//     client bundle and are read from NEXT_PUBLIC_* vars.
//   - The RP SIGNING KEY is server-only and is never referenced from this file.
//     It authenticates proof *requests* as coming from our app; leaking it lets
//     anyone forge requests in our name, so it is read only inside the route
//     handler at src/app/api/world-id/rp-signature/route.ts.

export const WORLD_APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
export const WORLD_RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID ?? "";
export const WORLD_ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION ?? "verify-payment-approver";

/**
 * "sandbox" drives the TestFlight / Play sandbox World ID app — the build a
 * reviewer installs to test Selfie Check. "staging" is the web simulator, which
 * does NOT exercise the camera flow. "production" is real World ID.
 */
export const WORLD_ENVIRONMENT = (process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT ?? "sandbox") as
  | "production"
  | "staging"
  | "sandbox";

/**
 * Which credential to request.
 *
 * `selfieCheckLegacy` is the B4 target and is ACCESS-GATED: World must enable a
 * per-app feature flag first, and a valid app or action does not imply access.
 * `proofOfHuman` is ungated and works today, so it is the fallback that keeps
 * the flow demonstrable while the flag is pending. Swapping between them is one
 * env var — no code change (same shape as the fallback/cre matcher swap, D09).
 */
export const WORLD_PRESET = (process.env.NEXT_PUBLIC_WORLD_PRESET ?? "selfieCheckLegacy") as
  | "selfieCheckLegacy"
  | "proofOfHuman";
