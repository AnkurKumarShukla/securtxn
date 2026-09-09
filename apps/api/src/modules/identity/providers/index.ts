// Provider selection. The only place IDENTITY_PROVIDER is read (D09).
// Spec: docs/architecture.md §4.7

import { resolve } from "node:path";
import type { Config } from "../../../config/index.js";
import type { IdentityProvider } from "../IdentityProvider.js";
import { DigiLockerProvider } from "./DigiLockerProvider.js";
import { GenericKycProvider } from "./GenericKycProvider.js";
import { MockIdentityProvider } from "./MockIdentityProvider.js";

export function createIdentityProvider(config: Config): IdentityProvider {
  switch (config.IDENTITY_PROVIDER) {
    case "digilocker":
      // Config already guarantees these are present when this provider is
      // selected, so the non-null assertions cannot fire at runtime (D22).
      return new DigiLockerProvider({
        baseUrl: config.SANDBOX_BASE_URL,
        apiKey: config.SANDBOX_LIVE_KEY!,
        apiSecret: config.SANDBOX_LIVE_SECRET!,
        redirectUrl: config.DIGILOCKER_REDIRECT_URL!,
      });

    case "generic":
      return new GenericKycProvider();

    case "mock":
      return new MockIdentityProvider({
        // Resolved against the repo root, so the same value works whether the
        // process starts in apps/api, the repo root, or a container.
        fixtureDir: resolve(config.repoRoot, config.DIGILOCKER_FIXTURE_DIR),
        consentStubBaseUrl: `http://${config.HOST}:${config.PORT}/dev/identity/consent`,
      });
  }
}

export { DigiLockerProvider } from "./DigiLockerProvider.js";
export { GenericKycProvider } from "./GenericKycProvider.js";
export { MockIdentityProvider } from "./MockIdentityProvider.js";
