// The vendor-lookup hook the CRE confidential workflow calls from inside the
// enclave (§4.4, D09).
//
// Direction, as with the identity registry: the workflow calls INTO this.
// Nothing here calls Chainlink, so it is core work and carries no partner
// dependency — the fallback matcher reads the same records in-process.
//
// WHAT THIS RETURNS: the minimum the match needs — legal name and registered
// wallets — and nothing else. The enclave compares these; it has no business
// seeing DOB, address, PAN or documents, and a wider projection here would put
// that PII inside an HTTP response for no reason (design principle 2, D27).
//
// Spec: docs/architecture.md §4.4

import { Uuid } from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const Params = z.object({ vendorId: Uuid });

const VendorLookupResponse = z.object({
  /**
   * DIGESTS, never names (D62). The enclave has no crypto, so it compares
   * HMACs rather than decrypting anything — which also means no plaintext
   * identity ever crosses into it, or over this wire.
   *
   * Null when the payee has nothing on file. That is a REFUSAL downstream, not
   * a wildcard: evaluateMatch treats a null digest as "cannot agree".
   */
  legalNameHmac: z.string().nullable(),
  panNumberHmac: z.string().nullable(),
  wallets: z.array(
    z.object({
      address: z.string(),
      network: z.string(),
      tokenContract: z.string().nullable(),
    }),
  ),
});

export const vendorLookupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/internal/vendor-lookup/:vendorId",
    {
      /**
       * Authenticated for the same reason the identity registry is: an open
       * endpoint mapping vendor ids to legal names and payout addresses is a
       * disclosure surface, machine-to-machine caller or not.
       */
      preHandler: app.requireAnyRole("agent", "approver", "bridge"),
      schema: {
        tags: ["internal"],
        summary: "Vendor name and registered wallets, for the vendor match",
        description:
          "Called by the CRE confidential workflow from inside the enclave, and by " +
          "the fallback matcher in-process. Returns only what a match needs: identity " +
          "DIGESTS and registered wallets — never a name or a PAN. 404 means no such " +
          "vendor, which the caller maps to VENDOR_NOT_FOUND.",
        security: [{ bearerAuth: [] }],
        params: Params,
        response: { 200: VendorLookupResponse },
      },
    },
    async (request, reply) => {
      const vendor = await app.prisma.vendor.findUnique({
        where: { id: request.params.vendorId },
        select: {
          legalNameHmac: true,
          panNumberHmac: true,
          wallets: {
            // Only CONFIRMED wallets are payout addresses. A pending or revoked
            // wallet must not satisfy a match — that is the same fail-closed
            // rule the registry hook applies (D38).
            where: { status: "CONFIRMED" },
            select: { address: true, network: true, tokenContract: true },
          },
        },
      });

      if (!vendor) return reply.callNotFound();

      return {
        legalNameHmac: vendor.legalNameHmac,
        panNumberHmac: vendor.panNumberHmac,
        wallets: vendor.wallets,
      };
    },
  );
};
