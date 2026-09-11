// Wallet registration and confirmation endpoints.
// Spec: docs/architecture.md §4.1

import {
  CallbackChannelsResponse,
  IdentityBindingMessageResponse,
  CallbackConfirmRequest,
  ControlProofRequest,
  CredentialResponse,
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
  const service = new WalletService({
    prisma: app.prisma,
    config: app.config,
    compliance: app.container.complianceGateway,
  });

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

  app.get(
    "/vendors/:id/wallets/:walletId/callback-channels",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["wallets"],
        summary: "Contacts an operator may dial to confirm this wallet (O6)",
        description:
          "Confirmation must reach a channel the registry or the identity flow already " +
          "knew, never one the submitter supplied. That means the operator has to be told " +
          "which number to call — and before this endpoint that value existed only in the " +
          "database, so the test suite could confirm a wallet and no operator could.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        response: { 200: CallbackChannelsResponse },
      },
    },
    async (request) => service.callbackChannels(request.params.id, request.params.walletId),
  );

  app.get(
    "/vendors/:id/wallets/:walletId/identity-binding-message",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["wallets"],
        summary: "The exact struct to sign for the identity binding (O5)",
        description:
          "The binding covers values only the server holds — the onboarding nonce, " +
          "the DigiLocker user id and both document hashes. Without this endpoint the " +
          "only way to assemble them was to read the database, so onboarding could be " +
          "completed by the test suite and by no real client.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        response: { 200: IdentityBindingMessageResponse },
      },
    },
    async (request) =>
      service.identityBindingMessage(request.params.id, request.params.walletId),
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

  app.get(
    "/vendors/:id/wallets/:walletId/credential",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "The verifiable credential minted at confirmation",
        description:
          "Referenced on-chain by grantKyc(account, vcId, validFrom, validTo, issuer). " +
          "Safe to disclose in full — it asserts THAT checks passed, never the documents " +
          "behind them.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        response: { 200: CredentialResponse },
      },
    },
    async (request) => service.getCredential(request.params.id, request.params.walletId),
  );

  app.post(
    "/vendors/:id/wallets/:walletId/grant-kyc",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["vendors"],
        summary: "Grant KYC on the ATS security for this wallet",
        description:
          "Submits grantKyc(account, vcId, validFrom, validTo, issuer) so the token " +
          "itself accepts transfers to this address. Separate from callback-confirm and " +
          "retryable: onboarding must not depend on a chain being reachable.",
        security: [{ bearerAuth: [] }],
        params: WalletParams,
        response: {
          200: z.object({
            txHash: z.string(),
            /** False when the mock gateway is active — nothing was broadcast. */
            broadcast: z.boolean(),
            credentialId: z.string(),
            securityId: z.string(),
          }),
        },
      },
    },
    async (request) => service.grantOnChainKyc(request.params.id, request.params.walletId),
  );
};
