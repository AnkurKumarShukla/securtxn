// The ERC-3643 identity-registry hook.
//
// This is the real Hedera ATS integration point, and the direction matters:
// ATS's Control List module calls INTO this endpoint. Nothing here calls
// Hedera, which is why it has no partner dependency and is core work rather
// than Track B (D20).
//
// It makes this platform's KYC the compliance backend the token actually
// consults, instead of a cosmetic badge next to it.
//
// Spec: docs/architecture.md §4.5

import { EvmAddress, Network, Uuid } from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const Params = z.object({ address: EvmAddress });

/** Optional: the same address can be registered on more than one network. */
const Query = z.object({ network: Network.optional() });

const RegistryResponse = z.object({
  verified: z.boolean(),
  vendorId: Uuid.nullable(),
  /** Echoed lowercased, so a caller can confirm what was actually looked up. */
  address: z.string(),
  checkedAt: z.string().datetime(),
});

export const identityRegistryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/internal/identity-registry/:address",
    {
      /**
       * Authenticated, despite being machine-to-machine.
       *
       * An open endpoint answering "is this address a confirmed vendor?" is an
       * enumeration surface: it would let anyone probe which addresses the
       * platform has business relationships with. Any role is accepted for the
       * MVP because the caller is a deployment-side relayer; a dedicated
       * `registry` role with its own secret is the right shape once this is
       * exposed to a third party.
       */
      preHandler: app.requireAnyRole("agent", "approver", "bridge"),
      schema: {
        tags: ["internal"],
        summary: "Is this address a confirmed payout address?",
        description:
          "Called by the ATS Control List module. Returns verified:false for unknown " +
          "addresses, for wallets still pending, and for revoked wallets — the default " +
          "answer is always 'no'.",
        security: [{ bearerAuth: [] }],
        params: Params,
        querystring: Query,
        response: { 200: RegistryResponse },
      },
    },
    async (request) => {
      const address = request.params.address.toLowerCase();

      const wallet = await app.prisma.vendorWallet.findFirst({
        where: {
          // EVM addresses are case-insensitive; a checksummed address from the
          // chain and a lowercased one in the database are the same address,
          // and an exact match would answer "not verified" for a confirmed
          // wallet.
          address: { equals: address, mode: "insensitive" },
          ...(request.query.network ? { network: request.query.network } : {}),
          // ONLY confirmed. Pending and revoked both answer no — this endpoint
          // gates transfers, so anything other than a positive confirmation
          // must fail closed.
          status: "CONFIRMED",
        },
        // An address can be re-registered as a later version after revocation;
        // the most recent confirmation is the current truth.
        orderBy: { version: "desc" },
        select: { vendorId: true },
      });

      return {
        verified: wallet !== null,
        vendorId: wallet?.vendorId ?? null,
        address,
        checkedAt: new Date().toISOString(),
      };
    },
  );
};
