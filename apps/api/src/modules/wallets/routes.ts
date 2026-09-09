// Wallet registration and confirmation endpoints.
// Spec: docs/architecture.md §4.1

import {
  CallbackConfirmRequest,
  ControlProofRequest,
  RegisterWalletRequest,
  RegisterWalletResponse,
  Uuid,
  WalletSummary,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { WalletService } from "./service.js";

const VendorParams = z.object({ id: Uuid });
const WalletParams = z.object({ id: Uuid, walletId: Uuid });

export const walletRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new WalletService({ prisma: app.prisma, config: app.config });

  app.post(
    "/vendors/:id/wallets",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Register a new wallet version",
        description:
          "Returns the challenge to sign. The wallet carries the vendor's onboarding " +
          "nonce, not a fresh one — a per-wallet nonce would prove nothing about whose " +
          "identity the key belongs to.",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        body: RegisterWalletRequest,
        response: { 201: RegisterWalletResponse },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await service.register(request.params.id, request.body)),
  );

  app.get(
    "/vendors/:id/wallets",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "List wallet versions",
        security: [{ bearerAuth: [] }],
        params: VendorParams,
        response: { 200: z.array(WalletSummary) },
      },
    },
    async (request) => service.list(request.params.id),
  );

  app.post(
    "/vendors/:id/wallets/:walletId/control-proof",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Submit the EIP-712 wallet control proof",
        description:
          "Proves KEY CUSTODY ONLY. Never sufficient for CONFIRMED on its own — a " +
          "thief holding a stolen key signs this correctly.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        body: ControlProofRequest,
        response: { 200: WalletSummary },
      },
    },
    async (request) =>
      service.submitControlProof(request.params.id, request.params.walletId, request.body.signature),
  );

  app.post(
    "/vendors/:id/wallets/:walletId/identity-binding",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Submit the EIP-712 IdentityBinding attestation",
        description:
          "Binds the verified identity to this wallet under the same onboarding nonce. " +
          "Signs over the nonce, the DigiLocker user id and both document hashes, so it " +
          "cannot be replayed against another onboarding attempt or identity.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        body: ControlProofRequest,
        response: { 200: WalletSummary },
      },
    },
    async (request) =>
      service.submitIdentityBinding(
        request.params.id,
        request.params.walletId,
        request.body.signature,
      ),
  );

  app.post(
    "/vendors/:id/wallets/:walletId/callback-confirm",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Confirm out-of-band and set CONFIRMED",
        description:
          "REJECTED unless channelUsed matches a contact from a source independent of " +
          "this submission. Requires the control proof, the identity binding and a " +
          "verified identity to already be in place.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        body: CallbackConfirmRequest,
        response: { 200: WalletSummary },
      },
    },
    async (request) =>
      service.confirmCallback(request.params.id, request.params.walletId, request.body),
  );
};
