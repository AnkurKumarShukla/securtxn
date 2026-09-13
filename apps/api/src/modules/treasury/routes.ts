// What each side of a payment actually holds on chain.
//
// WHY THIS IS NOT IN THE DEV MODULE ANY MORE. It began as a debugging helper
// and became a feature: the dashboard's balance card is this endpoint. Dev
// routes are not registered in production (see server.ts), so on the deployed
// site every balance read 404'd and the card said "could not read balances"
// with nothing to say which call had failed.
//
// It reads public chain data - a mirror node lookup and an ERC-20 balanceOf -
// for the platform treasury and, optionally, one payee address. Nothing here is
// private to a vendor, but it still requires an agent token: the treasury's
// holdings are not something to volunteer to anonymous callers.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { BadRequestError } from "../../lib/errors.js";

const AccountView = z.object({
  label: z.string(),
  evmAddress: z.string(),
  /** 0.0.x, or null when the address is not a Hedera account yet. */
  hederaId: z.string().nullable(),
  hbar: z.string().nullable(),
  /**
   * -1 means unlimited auto-association: the account receives any HTS token
   * without associating first. 0 means a token must be associated before it
   * can arrive, which is the usual reason a transfer to a fresh account fails.
   */
  maxAutoAssociations: z.number().nullable(),
  tokenBalance: z.string().nullable(),
});

const TreasuryResponse = z.object({
  asset: z.string(),
  tokenAddress: z.string(),
  decimals: z.number().int(),
  payer: AccountView,
  payee: AccountView.nullable(),
  /** Null when no amount was asked about. */
  canSend: z.boolean().nullable(),
});

export const treasuryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/treasury",
    {
      // The dev route this moved from had no auth, because nothing outside a
      // developer's own machine could reach it. On a public host the treasury's
      // holdings are not something to volunteer to anonymous callers, so the
      // move adds the check the old placement made unnecessary.
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["treasury"],
        summary: "Both sides of a payment, on chain",
        description:
          "A payment transfers the asset FROM the payer's treasury TO the payee. " +
          "Either side can silently make that impossible: an empty treasury, or a " +
          "payee that is not a Hedera account yet. Both are invisible until the " +
          "transfer reverts, so both are reported here for the asset actually " +
          "being sent — not for whatever token happens to be configured.",
        querystring: z.object({
          asset: z.string().default("USDC"),
          amount: z.string().optional(),
          payee: z.string().optional(),
        }),
        response: { 200: TreasuryResponse },
      },
    },
    async (request) => {
      const chain = app.container.chainGateway;
      const { asset, amount, payee } = request.query;

      // Resolved the same way `settle` resolves it, or the number on screen
      // would describe a different token than the one that moves.
      const symbol = asset.toUpperCase();
      const configured = app.config.TOKEN_ADDRESSES[symbol];
      const security = configured
        ? null
        : await app.prisma.security.findFirst({ where: { symbol }, orderBy: { createdAt: "desc" } });
      const tokenAddress = configured ?? security?.evmAddress;
      if (!tokenAddress) {
        throw new BadRequestError(
          `No address for '${symbol}'. Configure it in TOKEN_ADDRESSES or issue a security with that symbol.`,
        );
      }

      const decimals = await chain.decimals(tokenAddress as `0x${string}`);
      const unit = 10n ** BigInt(decimals);
      const format = (v: bigint) => {
        const whole = v / unit;
        const frac = (v % unit).toString().padStart(decimals, "0");
        return decimals === 0 ? whole.toString() : `${whole}.${frac}`;
      };

      const view = async (label: string, address: string) => {
        // The mirror node knows about ACCOUNTS; the ERC-20 call knows about
        // BALANCES. An address with no account answers neither, and saying so
        // is more useful than a zero that looks like an empty wallet.
        let hederaId: string | null = null;
        let hbar: string | null = null;
        let maxAutoAssociations: number | null = null;
        try {
          const base = app.config.HEDERA_MIRROR_NODE_URL!.replace(/\/$/, "");
          const res = await fetch(`${base}/accounts/${address}`);
          if (res.ok) {
            const body = (await res.json()) as {
              account?: string;
              balance?: { balance?: number };
              max_automatic_token_associations?: number;
            };
            hederaId = body.account ?? null;
            hbar = body.balance?.balance != null ? (body.balance.balance / 1e8).toFixed(4) : null;
            maxAutoAssociations = body.max_automatic_token_associations ?? null;
          }
        } catch {
          /* the mirror node is a convenience here, not the source of truth */
        }

        let tokenBalance: string | null = null;
        try {
          tokenBalance = format(
            await chain.balanceOf(tokenAddress as `0x${string}`, address as `0x${string}`),
          );
        } catch {
          // Reverts when the address is not an account, or the token is not
          // associated and cannot be.
          tokenBalance = null;
        }

        return { label, evmAddress: address, hederaId, hbar, maxAutoAssociations, tokenBalance };
      };

      const payerView = await view("Platform treasury (pays)", chain.treasuryAddress);
      const payeeView = payee ? await view("Payee (receives)", payee) : null;

      const wanted = amount ? BigInt(Math.round(Number(amount) * Number(unit))) : null;
      const held = payerView.tokenBalance
        ? BigInt(Math.round(Number(payerView.tokenBalance) * Number(unit)))
        : 0n;

      return {
        asset: symbol,
        tokenAddress,
        decimals,
        payer: payerView,
        payee: payeeView,
        canSend: wanted === null ? null : held >= wanted,
      };
    },
  );
};
