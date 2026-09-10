// Dependency injection root.
//
// The swappable dependencies are resolved here and nowhere else, so switching
// an implementation is a one-line change and the rest of the system never
// learns which one is active (D09):
//
//   IdentityProvider  digilocker | generic | mock   (§4.7)
//   VendorMatcher     fallback   | cre              (§4.4) — arrives with A5
//   SanctionsScreener stub       | live feed        (§6)   — arrives with A5
//
// Spec: docs/architecture.md §4.4

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { FallbackVendorMatcher, type VendorMatcher } from "@cp/cre-workflows";
import { CreVendorMatcher } from "./modules/vendorMatch/CreVendorMatcher.js";
import { invokeWorkflow } from "./modules/vendorMatch/creGateway.js";
import { privateKeyToAccount } from "viem/accounts";
import { createVendorMatchRequestStore } from "./modules/vendorMatch/vendorMatchRequestStore.js";
import { WorldIdService } from "./modules/worldid/service.js";
import { HttpWorldIdProofVerifier } from "./modules/worldid/WorldIdProofVerifier.js";
import { AtsComplianceGateway, MockComplianceGateway, type ComplianceGateway } from "@cp/contracts";
import type { PrismaClient } from "@prisma/client";
import type { IdentityProvider } from "./modules/identity/IdentityProvider.js";
import { createIdentityProvider } from "./modules/identity/providers/index.js";
import { createSanctionsScreener, type SanctionsScreener } from "./modules/sanctions/index.js";
import { createTierThresholds } from "./config/tiers.js";
import type { TierThresholds } from "./modules/decision/types.js";

export type Container = {
  identityProvider: IdentityProvider;
  vendorMatcher: VendorMatcher;
  sanctionsScreener: SanctionsScreener;
  tierThresholds: TierThresholds;
  /** On-chain KYC. Mock until the Hedera credentials and a security exist. */
  complianceGateway: ComplianceGateway;
  /**
   * Selfie Check continuity (B4, D49). Null when disabled — the routes then
   * refuse with 503 rather than quietly behaving as if the check passed.
   */
  worldId: WorldIdService | null;
};

declare module "fastify" {
  interface FastifyInstance {
    container: Container;
  }
}

/**
 * One instance per process. The mock provider holds session state in memory, so
 * constructing it per request would lose every session between the call that
 * starts one and the call that reads it.
 */
export function createContainer(
  config: FastifyInstance["config"],
  prisma: PrismaClient,
): Container {
  return {
    identityProvider: createIdentityProvider(config),

    // `cre-workflows` must not depend on Prisma — the same code has to run
    // inside a TEE — so the lookup is injected rather than imported (D09).
    vendorMatcher:
      config.VENDOR_MATCHER === "cre"
        ? createCreVendorMatcher(config, prisma)
        : new FallbackVendorMatcher({
            minScore: config.VENDOR_MATCH_MIN_SCORE,
            lookup: async (vendorId) => {
              const vendor = await prisma.vendor.findUnique({
                where: { id: vendorId },
                include: { wallets: true },
              });
              if (!vendor) return null;
              return {
                legalName:
                  vendor.legalEntityName ??
                  [vendor.legalFirstName, vendor.legalLastName].filter(Boolean).join(" "),
                wallets: vendor.wallets.map((w) => ({
                  address: w.address,
                  network: w.network,
                  tokenContract: w.tokenContract,
                })),
              };
            },
          }),

    sanctionsScreener: createSanctionsScreener(config),
    tierThresholds: createTierThresholds(config),

    // Real gateway only when explicitly selected AND fully configured. The
    // default is mock, so broadcasting a transaction is always a deliberate
    // choice — and the mock reports broadcast:false, so its result can never
    // be mistaken for an on-chain grant (D21).
    complianceGateway:
      config.COMPLIANCE_GATEWAY === "ats" &&
      config.ATS_ISSUER_PRIVATE_KEY &&
      config.HEDERA_JSON_RPC_URL &&
      config.HEDERA_MIRROR_NODE_URL
        ? new AtsComplianceGateway({
            chainId: config.HEDERA_CHAIN_ID,
            rpcUrl: config.HEDERA_JSON_RPC_URL,
            mirrorNodeUrl: config.HEDERA_MIRROR_NODE_URL,
            issuerPrivateKey: config.ATS_ISSUER_PRIVATE_KEY,
          })
        : new MockComplianceGateway(),

    // Requires BOTH the flag and an rp_id. Selfie Check is access-gated per app
    // and the Portal exposes no way to read that flag, so this switch is ours
    // (docs/world-id-feedback.md) — and it must be deliberate, never inferred.
    worldId:
      config.WORLD_FEATURE_FLAG_ENABLED && config.WORLD_RP_ID
        ? new WorldIdService({
            prisma,
            expectedAction: config.WORLD_ACTION,
            verifier: new HttpWorldIdProofVerifier({
              rpId: config.WORLD_RP_ID,
              baseUrl: config.WORLD_VERIFY_BASE_URL,
            }),
          })
        : null,
  };
}

/**
 * The CRE path (D47/D48).
 *
 * The workflow does not answer synchronously — it posts its verdict to
 * /internal/vendor-match-result and this matcher awaits the row. See
 * CreVendorMatcher for why the exchange is shaped that way.
 *
 * Missing config fails HERE, at boot, rather than at the first payment: a
 * misconfigured matcher that only reveals itself mid-flight is worse than one
 * that refuses to start (D21).
 */
function createCreVendorMatcher(
  config: FastifyInstance["config"],
  prisma: PrismaClient,
): VendorMatcher {
  const missing = (
    ["CRE_GATEWAY_URL", "CRE_WORKFLOW_ID", "CRE_CALLER_PRIVATE_KEY"] as const
  ).filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`VENDOR_MATCHER=cre requires ${missing.join(", ")} to be set`);
  }

  const account = privateKeyToAccount(config.CRE_CALLER_PRIVATE_KEY as `0x${string}`);

  return new CreVendorMatcher({
    store: createVendorMatchRequestStore(prisma),
    timeoutMs: config.CRE_MATCH_TIMEOUT_MS,
    invoke: (input) =>
      invokeWorkflow(
        {
          gatewayUrl: config.CRE_GATEWAY_URL as string,
          workflowId: config.CRE_WORKFLOW_ID as string,
          callerAddress: account.address,
          // viem applies the EIP-191 prefix and keccak256 internally, which is
          // exactly what the gateway verifies against.
          signMessage: (message) => account.signMessage({ message }),
        },
        input,
      ),
  });
}

async function containerPlugin(app: FastifyInstance): Promise<void> {
  app.decorate("container", createContainer(app.config, app.prisma));
  app.log.info(
    {
      identityProvider: app.config.IDENTITY_PROVIDER,
      vendorMatcher: app.config.VENDOR_MATCHER,
      sanctionsScreener: "stub",
      complianceGateway: app.container.complianceGateway.kind,
      worldId: app.container.worldId ? "enabled" : "disabled",
    },
    "resolved swappable implementations",
  );
}

export default fp(containerPlugin, { name: "container", dependencies: ["config", "prisma"] });
