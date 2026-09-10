// Issuance and lifecycle of tokenized receivables.
//
// Everything a treasury operator does to an instrument, driven from HTTP rather
// than from a script. The chain work lives in @cp/contracts; this service owns
// the ordering, the guards, and the record of what was done.
//
// TWO RULES RUN THROUGH ALL OF IT:
//
//   Amounts arriving here are human decimal strings and are scaled by the
//   token's OWN decimals, read from chain. Nothing assumes a scale.
//
//   A holder is named by vendorWalletId, never by raw address. Minting to an
//   arbitrary address would route value past every check the wallet
//   confirmation pipeline exists to make (D01, D34).
//
// Spec: docs/architecture.md §4.5

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ChainOperationResult,
  IssueSecurityRequest,
  MintRequest,
  RedeemRequest,
  SecurityEventSummary,
  SecurityHolding,
  SecuritySummary,
  SetCouponRequest,
  UpdateMaturityRequest,
} from "@cp/shared-types";
import { completeIsin, isValidIsin } from "@cp/contracts";
import type { Address } from "viem";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import type { ChainGateway } from "../../lib/chain.js";

export type SecurityServiceDeps = {
  prisma: PrismaClient;
  chain: ChainGateway;
};

type SecurityRow = Prisma.SecurityGetPayload<Record<string, never>>;

export class SecurityService {
  constructor(private readonly deps: SecurityServiceDeps) {}

  /**
   * Deploys a new bond through the ATS factory and prepares it.
   *
   * Prepare runs in the same call rather than as a follow-up endpoint. A
   * security that exists but has no registered credential issuer looks fine and
   * rejects every KYC grant made against it, which surfaces much later as an
   * unexplained revert during a payout (D40).
   */
  async issue(input: IssueSecurityRequest, actorId: string): Promise<SecuritySummary> {
    const maturityDate = new Date(input.maturityDate);
    const startingDate = input.startingDate ? new Date(input.startingDate) : new Date();

    if (maturityDate <= startingDate) {
      throw new UnprocessableError("maturityDate must be after startingDate");
    }
    if (maturityDate.getTime() <= Date.now()) {
      throw new UnprocessableError("maturityDate must be in the future");
    }

    // Generated rather than demanded when absent. The factory rejects a bad
    // check digit with WrongISINChecksum, and asking a UI to implement ISO 6166
    // is asking for that revert.
    const isin = input.isin ?? completeIsin(randomIsinBody(input.symbol));
    if (!isValidIsin(isin)) {
      throw new UnprocessableError(
        `ISIN '${isin}' fails the ISO 6166 check digit; omit it and one will be generated`,
      );
    }

    const maxSupply = toBaseUnits(input.maxSupply, input.decimals);
    if (maxSupply <= 0n) {
      throw new UnprocessableError("maxSupply must be greater than zero");
    }

    const deployed = await this.deps.chain.issueSecurity({
      name: input.name,
      symbol: input.symbol,
      isin,
      decimals: input.decimals,
      currency: input.currency,
      nominalValue: toBaseUnits(input.nominalValue, input.nominalValueDecimals),
      nominalValueDecimals: input.nominalValueDecimals,
      maxSupply,
      startingDate,
      maturityDate,
    });

    const prepared = await this.deps.chain.prepareSecurity(deployed.address);

    const security = await this.deps.prisma.$transaction(async (tx) => {
      const row = await tx.security.create({
        data: {
          evmAddress: deployed.address.toLowerCase(),
          name: input.name,
          symbol: input.symbol,
          isin,
          decimals: input.decimals,
          currency: input.currency,
          nominalValue: new Prisma.Decimal(input.nominalValue),
          nominalValueDecimals: input.nominalValueDecimals,
          maxSupply: maxSupply.toString(),
          startingDate,
          maturityDate,
          issuerRegistered: true,
          deployTxHash: deployed.txHash,
          issuedBy: actorId,
        },
      });

      await tx.securityEvent.create({
        data: {
          securityId: row.id,
          kind: "ISSUED",
          txHash: deployed.txHash,
          actorId,
          detail: { isin, maxSupply: maxSupply.toString(), address: deployed.address },
        },
      });

      // Recorded separately even when it was a no-op, because "was this token
      // ever prepared" is a question someone asks while debugging a reverted
      // grant, and the answer should be in the history.
      await tx.securityEvent.create({
        data: {
          securityId: row.id,
          kind: "PREPARED",
          txHash: prepared.txHashes[0] ?? deployed.txHash,
          actorId,
          detail: { alreadyPrepared: prepared.alreadyPrepared, txHashes: prepared.txHashes },
        },
      });

      return row;
    });

    return this.toSummary(security);
  }

  async list(): Promise<SecuritySummary[]> {
    const rows = await this.deps.prisma.security.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((row) => this.toSummary(row));
  }

  async get(id: string): Promise<SecuritySummary> {
    return this.toSummary(await this.load(id));
  }

  async events(id: string): Promise<SecurityEventSummary[]> {
    await this.load(id);
    const rows = await this.deps.prisma.securityEvent.findMany({
      where: { securityId: id },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      txHash: row.txHash,
      actorId: row.actorId,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Creates units and assigns them to a confirmed vendor wallet or the treasury.
   *
   * Both destinations are real cases. A receivable minted straight to the
   * supplier is the instrument being issued to whom it is owed; minting into the
   * treasury is how the platform funds an instrument it will pay out later,
   * which is the only way the settle route has anything to move.
   */
  async mint(id: string, input: MintRequest, actorId: string): Promise<ChainOperationResult> {
    const security = await this.load(id);
    const wallet = input.vendorWalletId ? await this.confirmedWallet(input.vendorWalletId) : null;
    const to = (wallet?.address ?? this.deps.chain.treasuryAddress) as Address;

    const baseUnits = toBaseUnits(input.amount, security.decimals);
    const supply = await this.deps.chain.totalSupply(address(security));
    if (supply + baseUnits > BigInt(security.maxSupply)) {
      throw new UnprocessableError(
        `Minting ${input.amount} would exceed the cap; the factory rejects it on chain too`,
      );
    }

    const txHash = await this.deps.chain.mint(address(security), to, baseUnits);

    return this.record(security, "MINTED", txHash, actorId, {
      to,
      ...(wallet ? { vendorWalletId: wallet.id } : { destination: "treasury" }),
      amount: input.amount,
      baseUnits: baseUnits.toString(),
    });
  }

  /**
   * Schedules a coupon.
   *
   * The record date must fall before the execution date and both before
   * maturity — the contract enforces the last one, and a coupon scheduled past
   * maturity reverts in a way that reads as a chain problem rather than a form
   * error.
   */
  async setCoupon(
    id: string,
    input: SetCouponRequest,
    actorId: string,
  ): Promise<ChainOperationResult> {
    const security = await this.load(id);
    const recordDate = new Date(input.recordDate);
    const executionDate = new Date(input.executionDate);

    if (executionDate <= recordDate) {
      throw new UnprocessableError("executionDate must be after recordDate");
    }
    if (executionDate > security.maturityDate) {
      throw new UnprocessableError(
        `executionDate is past maturity (${security.maturityDate.toISOString()}); move maturity first`,
      );
    }

    const txHash = await this.deps.chain.setCoupon(address(security), {
      recordDate,
      executionDate,
      startDate: new Date(),
      endDate: executionDate,
      fixingDate: new Date(),
      rate: toBaseUnits(input.rate, input.rateDecimals),
      rateDecimals: input.rateDecimals,
    });

    return this.record(security, "COUPON_SET", txHash, actorId, {
      recordDate: recordDate.toISOString(),
      executionDate: executionDate.toISOString(),
      rate: input.rate,
    });
  }

  /**
   * Moves the maturity date.
   *
   * Compared against CHAIN time, not this server's clock. The contract rejects
   * a date it considers past, and the two clocks are not the same one (D49).
   */
  async updateMaturity(
    id: string,
    input: UpdateMaturityRequest,
    actorId: string,
  ): Promise<ChainOperationResult> {
    const security = await this.load(id);
    const maturityDate = new Date(input.maturityDate);
    const now = await this.deps.chain.chainTime();

    if (maturityDate <= now) {
      throw new UnprocessableError(
        `maturityDate must be after chain time (${now.toISOString()}); the contract rejects a past date`,
      );
    }

    const txHash = await this.deps.chain.updateMaturity(address(security), maturityDate);

    await this.deps.prisma.security.update({
      where: { id },
      data: { maturityDate, status: "ISSUED" },
    });

    return this.record(security, "MATURITY_UPDATED", txHash, actorId, {
      maturityDate: maturityDate.toISOString(),
      previous: security.maturityDate.toISOString(),
    });
  }

  /**
   * Redeems a matured holding.
   *
   * The manual override on the sweep below. Refuses before maturity for the
   * same reason the contract does: a redemption is the instrument ending, and
   * ending it early is a decision, not a retry.
   */
  async redeem(id: string, input: RedeemRequest, actorId: string): Promise<ChainOperationResult> {
    const security = await this.load(id);
    const wallet = await this.confirmedWallet(input.vendorWalletId);
    const now = await this.deps.chain.chainTime();

    if (security.maturityDate > now) {
      throw new UnprocessableError(
        `Not matured until ${security.maturityDate.toISOString()}; the contract rejects an early redemption`,
      );
    }

    const held = await this.deps.chain.balanceOf(address(security), wallet.address as Address);
    const baseUnits = input.amount ? toBaseUnits(input.amount, security.decimals) : held;

    if (baseUnits <= 0n) throw new UnprocessableError("That wallet holds nothing to redeem");
    if (baseUnits > held) {
      throw new UnprocessableError(`That wallet holds ${fromBaseUnits(held, security.decimals)}`);
    }

    const txHash = await this.deps.chain.redeem(
      address(security),
      wallet.address as Address,
      baseUnits,
    );

    await this.deps.prisma.security.update({ where: { id }, data: { status: "MATURED" } });

    return this.record(security, "REDEEMED", txHash, actorId, {
      holder: wallet.address,
      vendorWalletId: wallet.id,
      amount: fromBaseUnits(baseUnits, security.decimals),
      baseUnits: baseUnits.toString(),
    });
  }

  /**
   * Redeems every known holding on every matured security.
   *
   * The backend half of redemption: nobody should have to remember to end an
   * instrument on its maturity date. It walks confirmed vendor wallets rather
   * than the token's own holder list, because a holding the platform never
   * confirmed is not one it should be unwinding unasked.
   *
   * One failure does not stop the sweep. A single holder whose redemption
   * reverts must not leave every later holder unredeemed.
   */
  async sweepMatured(actorId: string): Promise<{
    securitiesConsidered: number;
    redeemed: { securityId: string; holder: string; amount: string; txHash: string }[];
    failed: { securityId: string; holder: string; reason: string }[];
  }> {
    const now = await this.deps.chain.chainTime();
    const due = await this.deps.prisma.security.findMany({
      where: { status: "ISSUED", maturityDate: { lte: now } },
    });

    const redeemed: { securityId: string; holder: string; amount: string; txHash: string }[] = [];
    const failed: { securityId: string; holder: string; reason: string }[] = [];

    const wallets = await this.deps.prisma.vendorWallet.findMany({
      where: { status: "CONFIRMED" },
      select: { id: true, address: true },
    });

    for (const security of due) {
      let anyRedeemed = false;

      for (const wallet of wallets) {
        try {
          const held = await this.deps.chain.balanceOf(
            address(security),
            wallet.address as Address,
          );
          if (held <= 0n) continue;

          const txHash = await this.deps.chain.redeem(
            address(security),
            wallet.address as Address,
            held,
          );
          await this.record(security, "REDEEMED", txHash, actorId, {
            holder: wallet.address,
            vendorWalletId: wallet.id,
            amount: fromBaseUnits(held, security.decimals),
            baseUnits: held.toString(),
            sweep: true,
          });

          anyRedeemed = true;
          redeemed.push({
            securityId: security.id,
            holder: wallet.address,
            amount: fromBaseUnits(held, security.decimals),
            txHash,
          });
        } catch (err) {
          failed.push({
            securityId: security.id,
            holder: wallet.address,
            reason: err instanceof Error ? err.message.split("\n")[0]! : String(err),
          });
        }
      }

      if (anyRedeemed) {
        await this.deps.prisma.security.update({
          where: { id: security.id },
          data: { status: "MATURED" },
        });
      }
    }

    return { securitiesConsidered: due.length, redeemed, failed };
  }

  /** Balances for every confirmed wallet holding this security. */
  async holdings(id: string): Promise<SecurityHolding[]> {
    const security = await this.load(id);
    const wallets = await this.deps.prisma.vendorWallet.findMany({
      where: { status: "CONFIRMED" },
      select: { address: true },
    });

    const seen = new Set<string>();
    const holdings: SecurityHolding[] = [];

    for (const wallet of wallets) {
      const lower = wallet.address.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);

      const balance = await this.deps.chain.balanceOf(address(security), wallet.address as Address);
      if (balance <= 0n) continue;

      holdings.push({
        address: wallet.address as SecurityHolding["address"],
        balance: fromBaseUnits(balance, security.decimals),
        balanceBaseUnits: balance.toString(),
      });
    }

    return holdings;
  }

  private async record(
    security: SecurityRow,
    kind: Prisma.SecurityEventCreateInput["kind"],
    txHash: string,
    actorId: string,
    detail: Record<string, unknown>,
  ): Promise<ChainOperationResult> {
    await this.deps.prisma.securityEvent.create({
      data: { securityId: security.id, kind, txHash, actorId, detail: detail as Prisma.InputJsonValue },
    });

    return {
      securityId: security.id,
      kind,
      txHash,
      explorerUrl: this.deps.chain.explorerUrl("transaction", txHash),
      broadcast: this.deps.chain.broadcasts,
      detail,
    };
  }

  private async load(id: string): Promise<SecurityRow> {
    const security = await this.deps.prisma.security.findUnique({ where: { id } });
    if (!security) throw new NotFoundError(`Security '${id}'`);
    return security;
  }

  /**
   * A wallet that finished the confirmation pipeline.
   *
   * PENDING or REVOKED is refused here rather than deferred to the chain: the
   * token would accept a mint to an address with KYC even after this platform
   * revoked its wallet, and that divergence is exactly the gap the wallet
   * status exists to close.
   */
  private async confirmedWallet(walletId: string) {
    const wallet = await this.deps.prisma.vendorWallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundError(`Wallet '${walletId}'`);
    if (wallet.status !== "CONFIRMED") {
      throw new ConflictError(`Wallet is '${wallet.status}'; only a CONFIRMED wallet may hold units`);
    }
    return wallet;
  }

  private toSummary(row: SecurityRow): SecuritySummary {
    return {
      id: row.id,
      evmAddress: row.evmAddress as SecuritySummary["evmAddress"],
      hederaId: row.hederaId,
      name: row.name,
      symbol: row.symbol,
      isin: row.isin,
      decimals: row.decimals,
      currency: row.currency,
      nominalValue: row.nominalValue.toString(),
      maxSupply: row.maxSupply,
      startingDate: row.startingDate.toISOString(),
      maturityDate: row.maturityDate.toISOString(),
      status: row.status,
      issuerRegistered: row.issuerRegistered,
      deployTxHash: row.deployTxHash,
      explorerUrl: this.deps.chain.explorerUrl("contract", row.hederaId ?? row.evmAddress),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function address(security: SecurityRow): Address {
  return security.evmAddress as Address;
}

/**
 * Human decimal string to base units.
 *
 * Done on strings, never through a float. `Number("0.1") * 100` is 10.000000000000002,
 * and this value is a quantity of money about to be written to a ledger that
 * does not take corrections.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new UnprocessableError(
      `'${amount}' has more than ${decimals} decimal places; the token cannot represent it`,
    );
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Eleven ISIN body characters derived from the symbol.
 *
 * The country prefix is IN because these are Indian receivables. The random
 * tail is what keeps two instruments from the same issuer distinct; the check
 * digit is added by completeIsin.
 */
function randomIsinBody(symbol: string): string {
  const prefix = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "X");
  const tail = Array.from({ length: 5 }, () =>
    "0123456789".charAt(Math.floor(Math.random() * 10)),
  ).join("");
  return `IN${prefix}${tail}`;
}
