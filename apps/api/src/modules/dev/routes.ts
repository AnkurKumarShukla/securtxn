// Local development helpers. Registered only when NODE_ENV !== production —
// see server.ts. There is no flag to turn these on in production; the guard is
// the absence of the registration, not a boolean someone can flip.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Role } from "@cp/shared-types";
import { z } from "zod";
import { MockIdentityProvider } from "../identity/providers/MockIdentityProvider.js";
import { BadRequestError } from "../../lib/errors.js";

const TokenRequest = z.object({
  role: Role,
  subject: z.string().min(1).default("local-dev"),
});

const TokenResponse = z.object({
  token: z.string(),
  role: Role,
  expiresIn: z.string(),
});

const ReleaseRequest = z.object({
  /**
   * Release EVERY identity link, including vendors with a confirmed wallet.
   *
   * Off by default, because a confirmed wallet means somebody finished
   * onboarding — releasing that silently would undo a counterparty's work and
   * the next symptom would be a payment to a vendor whose identity vanished.
   */
  force: z.boolean().default(false),
});

const ReleaseResponse = z.object({
  released: z.number().int(),
  vendorIds: z.array(z.string()),
  keptVendorIds: z.array(z.string()),
});

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

export const devRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/dev/treasury",
    {
      schema: {
        tags: ["dev"],
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

  app.post(
    "/dev/identity/release",
    {
      schema: {
        tags: ["dev"],
        summary: "Detach the recorded DigiLocker identity from every vendor",
        description:
          "The recorded fixture holds ONE identity, and the API refuses to attach it " +
          "to a second vendor — correctly, since that check is what stops two vendors " +
          "claiming the same person. That makes a demo un-rerunnable: the first run's " +
          "payee keeps the identity and every later run gets a 409. " +
          "This clears the link so the fixture can be reused. It exists because the " +
          "test suite already does exactly this by writing to the database directly, " +
          "which a browser cannot do. Dev only — it is not registered in production.",
        body: ReleaseRequest,
        response: { 200: ReleaseResponse },
      },
    },
    async (request) => {
      const holders = await app.prisma.vendor.findMany({
        where: { digilockerUserId: { not: null } },
        select: { id: true, wallets: { select: { status: true } } },
      });

      // An ABANDONED attempt has no confirmed wallet. Those are what block a
      // retry, and those are what this releases. A vendor someone actually
      // finished onboarding is left alone unless `force` says otherwise.
      const releasable = holders.filter(
        (v) => request.body.force || !v.wallets.some((w) => w.status === "CONFIRMED"),
      );
      const kept = holders.filter((v) => !releasable.includes(v));

      // Only the link is cleared. The vendor, its wallets and its digests stay,
      // because deleting them would take the evidence chain with them.
      const { count } = await app.prisma.vendor.updateMany({
        where: { id: { in: releasable.map((v) => v.id) } },
        data: { digilockerUserId: null },
      });

      return {
        released: count,
        vendorIds: releasable.map((v) => v.id),
        keptVendorIds: kept.map((v) => v.id),
      };
    },
  );

  app.post(
    "/dev/token",
    {
      schema: {
        tags: ["dev"],
        summary: "Mint a role-scoped token for testing",
        description:
          "Returns a JWT signed with that role's secret. Paste it into the " +
          "Authorize dialog to call protected endpoints. Minting an 'agent' token " +
          "and calling an approver route is the quickest way to see the role " +
          "separation reject you.",
        body: TokenRequest,
        response: { 200: TokenResponse },
      },
    },
    async (request) => {
      const { role, subject } = request.body;
      return {
        token: await app.signToken(role, subject),
        role,
        expiresIn: "12h",
      };
    },
  );

  /**
   * Stand-in for the DigiLocker consent screen.
   *
   * Served by the API rather than apps/web so the identity flow is complete
   * without a frontend: this page is what a session's authorizationUrl points
   * at in mock mode. When apps/web exists it can render its own version and
   * call this endpoint — the state machine is the same either way.
   *
   * Visiting it is the mocked human step, and it is the ONLY way a mock session
   * reaches "succeeded". Mock mode must never short-circuit there, or bugs in
   * the polling path go undetected until the single live run (D17).
   */
  app.get(
    "/dev/identity/consent",
    {
      schema: {
        tags: ["dev"],
        summary: "Mock DigiLocker consent screen — grants consent for a session",
        querystring: z.object({ session_id: z.string().min(1) }),
        response: { 200: z.string() },
      },
    },
    async (request, reply) => {
      const provider = app.container.identityProvider;
      if (!(provider instanceof MockIdentityProvider)) {
        // Consent for a real session happens at DigiLocker, not here.
        throw new BadRequestError(
          "Consent stub is only available when IDENTITY_PROVIDER=mock",
        );
      }

      const { session_id: sessionId } = request.query;
      provider.grantConsent(sessionId);

      return reply.type("text/html").send(
        `<!doctype html><meta charset="utf-8"><title>Consent granted</title>` +
          `<body style="font:16px system-ui;max-width:34rem;margin:4rem auto">` +
          `<h1>Consent granted</h1>` +
          `<p>Session <code>${escapeHtml(sessionId)}</code> is now <strong>succeeded</strong>.</p>` +
          `<p>This stands in for the DigiLocker consent screen. The real one is ` +
          `PKCE-protected and cannot be automated.</p>` +
          `<p>Next: <code>POST /vendors/:id/identity/complete</code>.</p></body>`,
      );
    },
  );
};

/** The session id is echoed into HTML; it is caller-supplied, so escape it. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c] ?? c;
  });
}
