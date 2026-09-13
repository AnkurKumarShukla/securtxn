// Releasing an approved payment, and the escrow lifecycle that follows.
//
// This is the service that actually spends. Everything else in the payments
// module decides, records or reports; these four operations broadcast.
//
// THE APPROVAL GATE IS THE ONLY THING BETWEEN A TOKEN AND THE TREASURY. `settle`
// is approver-scoped and refuses any payment that is not AWAITING_APPROVAL,
// which means the decision engine cleared it and a proposal exists. An agent
// token cannot reach it. That is a weaker guarantee than "the API holds no key"
// (D12), and the honest way to state it is: moving money needs an approver
// token and leaves an evidence record, not that it is impossible here.
//
// THE SECRET IS THE ESCROW. For an HTLC payment the platform generates the
// preimage, publishes only its hash on chain, and stores the secret encrypted.
// Handing it out on a role token would make the platform's own API key
// sufficient to collect someone else's payment, so release requires an EIP-712
// signature from the payout address itself (D41).
//
// Spec: docs/architecture.md §4.1, §4.5

import { computeLockId, hashlockFor, newPreimage, paymentRefFor } from "@cp/contracts";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ReleaseSecretRequest,
  ReleaseSecretResponse,
  RefundSweepResult,
  SettleRequest,
  SettleResponse,
  SettlementSummary,
} from "@cp/shared-types";
import type { Address, Hex } from "viem";
import type { Config } from "../../config/index.js";
import type { ChainGateway } from "../../lib/chain.js";
import { decryptJson, encryptJson } from "../../lib/crypto.js";
import { buildSecretReleaseMessage, verifySecretRelease } from "../../lib/eip712.js";
import { ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import type { EvidenceService } from "../evidence/service.js";
import type { ExceptionService } from "../exceptions/service.js";
import { fromBaseUnits, toBaseUnits } from "../securities/service.js";
import { toSettlementSummary, writeLockRecord } from "./settlement.js";

export type PaymentSettlerDeps = {
  prisma: PrismaClient;
  chain: ChainGateway;
  evidence: EvidenceService;
  exceptions: ExceptionService;
  config: Config;
};

export class PaymentSettler {
  constructor(private readonly deps: PaymentSettlerDeps) {}

  /**
   * Broadcasts an approved payment and records it.
   *
   * DIRECT is one transfer. HTLC is a secret, an approve and a lock, and the
   * money does not reach the payee until they claim it. Both end with the
   * payment SENT and an evidence trail, because from the sender's ledger the
   * funds have left either way.
   */
  async settle(
    paymentId: string,
    input: SettleRequest,
    approverId: string,
  ): Promise<SettleResponse> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: paymentId },
      include: { vendorWallet: true, proposal: true, htlcSettlement: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${paymentId}'`);

    // The same gate the bridge path enforces. A payment the engine refused, or
    // one already sent, must not be released by a second route (D07).
    if (payment.status !== "AWAITING_APPROVAL") {
      throw new ConflictError(
        `Payment is '${payment.status}'; only an AWAITING_APPROVAL payment can be settled`,
      );
    }
    if (payment.htlcSettlement) {
      throw new ConflictError("This payment already has an escrow");
    }

    const token = await this.resolveToken(payment.token, payment.vendorWallet.tokenContract);
    const decimals = await this.deps.chain.decimals(token);
    const baseUnits = toBaseUnits(payment.amount.toString(), decimals);
    const payee = payment.vendorWallet.address as Address;

    // Checked BEFORE broadcasting. An under-funded treasury reverts on chain,
    // which costs gas and arrives as an opaque "transfer reverted" — a 500 that
    // reads like a platform fault when it is an operational one. A balance read
    // is free and names the actual problem.
    if (this.deps.chain.broadcasts) {
      const held = await this.deps.chain.balanceOf(token, this.deps.chain.treasuryAddress);
      if (held < baseUnits) {
        const scale = (v: bigint) => {
          const unit = 10n ** BigInt(decimals);
          return decimals === 0
            ? v.toString()
            : `${v / unit}.${(v % unit).toString().padStart(decimals, "0")}`;
        };
        throw new UnprocessableError(
          `The treasury holds ${scale(held)} ${payment.token} but this payment needs ` +
            `${scale(baseUnits)}. Fund ${this.deps.chain.treasuryAddress} before settling.`,
        );
      }
    }

    if (payment.settlementMode !== "HTLC") {
      return this.settleDirectly({ payment, token, baseUnits, payee, approverId });
    }

    // The fork. Payer-funded escrow does not broadcast here — the platform does
    // not hold the payer's key and must not. Under the mock gateway there is no
    // payer wallet to prompt either, so that path stays on the treasury.
    return this.deps.config.SETTLEMENT_FUNDING === "payer" && this.deps.chain.broadcasts
      ? this.prepareEscrowForPayer({ payment, token, decimals, baseUnits, payee, input, approverId })
      : this.settleThroughEscrow({ payment, token, decimals, baseUnits, payee, input, approverId });
  }

  /**
   * Authorises an escrow the PAYER will fund, without moving anything.
   *
   * The secret is generated here and stays here. It has to: the payee claims by
   * revealing it, so whoever holds it can take the money, and a payer who knew
   * it could drain their own escrow the moment it was funded. That is the whole
   * reason this is a two-step settle rather than one — the platform must choose
   * the secret and cannot broadcast, the payer can broadcast and must never see
   * the secret.
   *
   * Every other lock parameter is pinned now as well, including the lock id,
   * which the contract derives from all of them. The payer's wallet is handed an
   * instruction it can verify and cannot usefully alter: change the payee, the
   * amount or the timelock and the resulting lock id no longer matches the one
   * recorded here, and `recordLock` refuses it.
   *
   * The payment goes to APPROVED, not SENT. Nobody has paid yet, and a payment
   * marked sent before the money moves is the one lie this flow cannot afford.
   */
  private async prepareEscrowForPayer(args: {
    payment: {
      id: string;
      network: string;
      token: string;
      amount: Prisma.Decimal;
      payerVendorId: string | null;
      proposal: { id: string } | null;
    };
    token: Address;
    decimals: number;
    baseUnits: bigint;
    payee: Address;
    input: SettleRequest;
    approverId: string;
  }): Promise<SettleResponse> {
    const payer = await this.payerAddressFor(args.payment.payerVendorId);

    const seconds = args.input.timelockSeconds ?? this.deps.config.HTLC_TIMELOCK_SECONDS;
    const timelock = new Date(Date.now() + seconds * 1000);
    const timelockSeconds = Math.floor(timelock.getTime() / 1000);

    const preimage = newPreimage();
    const hashlock = hashlockFor(preimage);

    const escrowAddress = this.escrowAddressOf("");
    const paymentRef = paymentRefFor(args.payment.id);
    const lockId = computeLockId({
      paymentRef,
      payer,
      payee: args.payee,
      token: args.token,
      amount: args.baseUnits,
      hashlock,
      timelock: BigInt(timelockSeconds),
    });

    const sealed = encryptJson({ preimage }, this.deps.config.PII_ENCRYPTION_KEY);
    const amount = fromBaseUnits(args.baseUnits, args.decimals);

    const settlement = await this.deps.prisma.$transaction(async (tx) => {
      const blob = await tx.encryptedBlob.create({
        data: {
          kind: "HTLC_PREIMAGE",
          ciphertext: new Uint8Array(sealed.ciphertext),
          iv: new Uint8Array(sealed.iv),
          authTag: new Uint8Array(sealed.authTag),
          contentType: "application/json",
          byteLength: sealed.ciphertext.byteLength,
        },
      });

      const row = await tx.htlcSettlement.create({
        data: {
          paymentRequestId: args.payment.id,
          escrowAddress,
          lockId,
          hashlock,
          timelock,
          payerAddress: payer,
          payeeAddress: args.payee,
          tokenAddress: args.token,
          amount,
          onChainAmount: args.baseUnits.toString(),
          status: "PENDING_LOCK",
          // No transaction exists yet. This is the column the migration made
          // nullable, and null here is the honest value.
          lockTxHash: null,
          preimageEncryptedRef: blob.id,
        },
      });

      await tx.paymentRequest.update({
        where: { id: args.payment.id },
        data: { status: "APPROVED" },
      });

      return row;
    });

    return {
      paymentRequestId: args.payment.id,
      mode: "HTLC",
      status: "APPROVED",
      txHash: null,
      explorerUrl: null,
      broadcast: false,
      settlement: toSettlementSummary(settlement),
      preparedLock: {
        escrowAddress,
        lockId,
        paymentRef,
        payerAddress: payer,
        payeeAddress: args.payee,
        tokenAddress: args.token,
        amount,
        onChainAmount: args.baseUnits.toString(),
        hashlock,
        timelock: timelock.toISOString(),
        timelockSeconds,
      },
    };
  }

  /**
   * The address the payer must send from.
   *
   * Their CONFIRMED wallet, not whatever is connected in their browser. The
   * contract records msg.sender as the party a refund returns to, so this is
   * also the address that gets the money back if nobody claims — which makes it
   * exactly as much a subject of verification as the payee's.
   */
  private async payerAddressFor(payerVendorId: string | null): Promise<Address> {
    if (!payerVendorId) {
      throw new UnprocessableError(
        "This payment records no payer organisation, so there is no wallet to fund the escrow from",
      );
    }
    const wallet = await this.deps.prisma.vendorWallet.findFirst({
      where: { vendorId: payerVendorId, status: "CONFIRMED" },
      orderBy: { version: "desc" },
      select: { address: true },
    });
    if (!wallet) {
      throw new UnprocessableError(
        "The paying organisation has no confirmed payout wallet. Connect and verify a wallet in Setup before settling.",
      );
    }
    return wallet.address as Address;
  }

  /**
   * Hands the secret to the payee, and only to them.
   *
   * The signature must recover to the address the escrow pays out to. It also
   * names the lock id, so a signature captured for one escrow cannot be
   * replayed against the payee's next one.
   */
  async releaseSecret(
    paymentId: string,
    input: ReleaseSecretRequest,
  ): Promise<ReleaseSecretResponse> {
    const settlement = await this.deps.prisma.htlcSettlement.findUnique({
      where: { paymentRequestId: paymentId },
      include: { preimageBlob: true },
    });
    if (!settlement) throw new NotFoundError(`Escrow for payment '${paymentId}'`);

    if (settlement.status !== "LOCKED") {
      throw new ConflictError(`Escrow is '${settlement.status}'; there is nothing left to claim`);
    }
    // Refused rather than released with a warning. The contract closes claiming
    // at the timelock, so the secret is worthless here and handing it over
    // would only look like the payment can still be collected.
    if (settlement.timelock.getTime() <= Date.now()) {
      throw new UnprocessableError(
        `The claim window closed at ${settlement.timelock.toISOString()}; this escrow is refundable`,
      );
    }
    if (!settlement.preimageBlob) {
      throw new UnprocessableError(
        "This escrow's secret was never held by the platform; it was opened by an external signer",
      );
    }

    const valid = await verifySecretRelease({
      chainId: this.deps.config.HEDERA_CHAIN_ID,
      address: settlement.payeeAddress,
      signature: input.signature,
      message: buildSecretReleaseMessage({
        paymentRequestId: paymentId,
        recipientAddress: settlement.payeeAddress,
        lockId: settlement.lockId,
      }),
    });
    if (!valid) {
      throw new UnprocessableError("Signature does not recover to the payee address");
    }

    const stored = decryptJson<{ preimage: string }>(
      {
        ciphertext: Buffer.from(settlement.preimageBlob.ciphertext),
        iv: Buffer.from(settlement.preimageBlob.iv),
        authTag: Buffer.from(settlement.preimageBlob.authTag),
      },
      this.deps.config.PII_ENCRYPTION_KEY,
    );

    // Recorded, not gated on. The payee may legitimately ask twice, having lost
    // the first response — but a second release long after the first is worth
    // seeing in an investigation.
    await this.deps.prisma.htlcSettlement.update({
      where: { id: settlement.id },
      data: { preimageReleasedAt: new Date() },
    });

    return {
      paymentRequestId: paymentId,
      lockId: settlement.lockId as ReleaseSecretResponse["lockId"],
      escrowAddress: settlement.escrowAddress as ReleaseSecretResponse["escrowAddress"],
      preimage: stored.preimage as ReleaseSecretResponse["preimage"],
      timelock: settlement.timelock.toISOString(),
      onChainAmount: settlement.onChainAmount,
    };
  }

  /** Broadcasts the refund for one expired escrow, then records it. */
  async executeRefund(paymentId: string, actorId: string): Promise<SettlementSummary> {
    const settlement = await this.deps.prisma.htlcSettlement.findUnique({
      where: { paymentRequestId: paymentId },
    });
    if (!settlement) throw new NotFoundError(`Escrow for payment '${paymentId}'`);
    if (settlement.status !== "LOCKED") {
      throw new ConflictError(`Escrow is '${settlement.status}'; it cannot be refunded`);
    }
    if (settlement.timelock.getTime() > Date.now()) {
      throw new UnprocessableError(
        `Not refundable until ${settlement.timelock.toISOString()}; the contract refuses it too`,
      );
    }

    const txHash = await this.deps.chain.refund(settlement.lockId as Hex);
    return this.recordRefund(paymentId, settlement.id, txHash, actorId);
  }

  /**
   * Returns every escrow whose claim window has closed.
   *
   * The scheduled half of recovery. Without it a misdirected payment sits in
   * escrow indefinitely and the refund never happens, which would make the
   * product's central promise depend on somebody remembering.
   *
   * One failure never stops the sweep.
   */
  async sweepRefunds(actorId: string): Promise<RefundSweepResult> {
    const expired = await this.deps.prisma.htlcSettlement.findMany({
      where: { status: "LOCKED", timelock: { lte: new Date() } },
      orderBy: { timelock: "asc" },
    });

    const refunded: RefundSweepResult["refunded"] = [];
    const failed: RefundSweepResult["failed"] = [];

    for (const settlement of expired) {
      try {
        const txHash = await this.deps.chain.refund(settlement.lockId as Hex);
        await this.recordRefund(settlement.paymentRequestId, settlement.id, txHash, actorId);
        refunded.push({
          paymentRequestId: settlement.paymentRequestId,
          lockId: settlement.lockId as RefundSweepResult["refunded"][number]["lockId"],
          txHash,
        });
      } catch (err) {
        failed.push({
          paymentRequestId: settlement.paymentRequestId,
          reason: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        });
      }
    }

    return { expiredFound: expired.length, refunded, failed };
  }

  // --- internals ------------------------------------------------------------

  private async settleDirectly(args: {
    payment: { id: string; network: string; token: string; amount: Prisma.Decimal; proposal: { id: string } | null };
    token: Address;
    baseUnits: bigint;
    payee: Address;
    approverId: string;
  }): Promise<SettleResponse> {
    const txHash = await this.deps.chain.transfer(args.token, args.payee, args.baseUnits);
    await this.markSent(args.payment, txHash, args.approverId, args.payee);

    return {
      paymentRequestId: args.payment.id,
      mode: "DIRECT",
      status: "SENT",
      txHash,
      explorerUrl: this.deps.chain.explorerUrl("transaction", txHash),
      broadcast: this.deps.chain.broadcasts,
      // Treasury-funded: nothing is left for the payer to do.
      preparedLock: null,
      settlement: null,
    };
  }

  private async settleThroughEscrow(args: {
    payment: {
      id: string;
      network: string;
      token: string;
      amount: Prisma.Decimal;
      proposal: { id: string } | null;
    };
    token: Address;
    decimals: number;
    baseUnits: bigint;
    payee: Address;
    input: SettleRequest;
    approverId: string;
  }): Promise<SettleResponse> {
    const seconds = args.input.timelockSeconds ?? this.deps.config.HTLC_TIMELOCK_SECONDS;
    const timelock = new Date(Date.now() + seconds * 1000);

    // Generated here and never sent anywhere until the payee proves the address
    // is theirs. Only the hash reaches the chain.
    const preimage = newPreimage();
    const hashlock = hashlockFor(preimage);

    const locked = await this.deps.chain.lock({
      paymentRequestId: args.payment.id,
      payee: args.payee,
      token: args.token,
      amount: args.baseUnits,
      hashlock,
      timelock,
    });

    const sealed = encryptJson({ preimage }, this.deps.config.PII_ENCRYPTION_KEY);

    // One transaction for the whole thing. A lock on chain with no row beside
    // it is money the platform cannot find; a row with no secret is a payment
    // the payee can never collect.
    const settlement = await this.deps.prisma.$transaction(async (tx) => {
      const blob = await tx.encryptedBlob.create({
        data: {
          kind: "HTLC_PREIMAGE",
          ciphertext: new Uint8Array(sealed.ciphertext),
          iv: new Uint8Array(sealed.iv),
          authTag: new Uint8Array(sealed.authTag),
          contentType: "application/json",
          byteLength: sealed.ciphertext.byteLength,
        },
      });

      const row = await writeLockRecord(tx, this.deps.evidence, {
        paymentRequestId: args.payment.id,
        payeeAddress: args.payee,
        timelock,
        preimageEncryptedRef: blob.id,
        input: {
          escrowAddress: this.escrowAddressOf(locked.lockTxHash),
          lockId: locked.lockId,
          hashlock,
          timelock: timelock.toISOString(),
          payerAddress: locked.payer,
          tokenAddress: args.token,
          amount: fromBaseUnits(args.baseUnits, args.decimals),
          onChainAmount: args.baseUnits.toString(),
          lockTxHash: locked.lockTxHash,
        },
      });

      await this.writeSent(tx, args.payment, locked.lockTxHash, args.approverId, args.payee);
      return row;
    });

    return {
      paymentRequestId: args.payment.id,
      mode: "HTLC",
      status: "SENT",
      txHash: locked.lockTxHash,
      explorerUrl: this.deps.chain.explorerUrl("transaction", locked.lockTxHash),
      broadcast: this.deps.chain.broadcasts,
      // Treasury-funded: nothing is left for the payer to do.
      preparedLock: null,
      settlement: toSettlementSummary(settlement),
    };
  }

  private async markSent(
    payment: { id: string; network: string; token: string; amount: Prisma.Decimal; proposal: { id: string } | null },
    txHash: string,
    approverId: string,
    payee: string,
  ): Promise<void> {
    await this.deps.prisma.$transaction((tx) =>
      this.writeSent(tx, payment, txHash, approverId, payee),
    );
  }

  /**
   * The status change, the approval record and the send evidence, together.
   *
   * Mirrors what the bridge path writes on report-sent, because a payment
   * released through this route and one released through the bridge must read
   * identically in a dispute.
   */
  private async writeSent(
    tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
    payment: { id: string; network: string; token: string; amount: Prisma.Decimal; proposal: { id: string } | null },
    txHash: string,
    approverId: string,
    payee: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString();

    await tx.paymentRequest.update({
      where: { id: payment.id },
      data: { status: "SENT", txHash },
    });

    await tx.approvalEvent.create({
      data: {
        paymentRequestId: payment.id,
        approverId,
        selfieCheckVerified: false,
        // False, and stated as such. No device confirmed this: it was released
        // through the API by an approver-scoped token. Reporting it as a device
        // confirmation would misdescribe the custody model (D32).
        ledgerConfirmed: false,
        ledgerConfirmedAt: new Date(),
      },
    });

    if (payment.proposal) {
      await tx.proposal.update({
        where: { id: payment.proposal.id },
        data: { consumedAt: new Date() },
      });
    }

    await this.deps.evidence.append(tx, {
      eventType: "approval",
      paymentRequestId: payment.id,
      timestamp,
      data: { approverId, selfieCheckVerified: false, ledgerConfirmed: false },
    });

    await this.deps.evidence.append(tx, {
      eventType: "send",
      paymentRequestId: payment.id,
      timestamp,
      data: {
        txHash,
        network: payment.network,
        toAddress: payee as `0x${string}`,
        amount: payment.amount.toString(),
        token: payment.token,
      },
    });
  }

  private async recordRefund(
    paymentId: string,
    settlementId: string,
    txHash: string,
    actorId: string,
  ): Promise<SettlementSummary> {
    const settledAt = new Date();
    const timestamp = settledAt.toISOString();

    const updated = await this.deps.prisma.$transaction(async (tx) => {
      const row = await tx.htlcSettlement.update({
        where: { id: settlementId },
        data: { status: "REFUNDED", refundTxHash: txHash, settledAt },
      });

      await tx.paymentRequest.update({
        where: { id: paymentId },
        data: { status: "EXCEPTION" },
      });

      await this.deps.evidence.append(tx, {
        eventType: "htlc_refunded",
        paymentRequestId: paymentId,
        timestamp,
        data: {
          lockId: row.lockId as `0x${string}`,
          refundedTo: row.payerAddress as `0x${string}`,
          amount: row.amount.toString(),
          txHash,
        },
      });

      // The money is back, which is the good outcome. A verified payee who
      // never collected an approved payment is not, and nobody finds out from
      // a balance quietly returning to normal.
      const existing = await tx.exceptionCase.findUnique({
        where: { paymentRequestId: paymentId },
      });
      if (!existing) {
        await this.deps.exceptions.createWithin(tx, {
          paymentRequestId: paymentId,
          type: "MISDIRECT",
          openedBy: actorId,
        });
      }

      return row;
    });

    return toSettlementSummary(updated);
  }

  /**
   * The escrow the platform locks into.
   *
   * Read from config rather than from the transaction, because the address must
   * be known before the lock is sent, not discovered after. The chain gateway
   * has already refused to broadcast if it is unset.
   */
  private escrowAddressOf(_lockTxHash: string): Address {
    const configured = this.deps.config.HTLC_CONTRACT_ADDRESS;
    if (configured) return configured as Address;
    // Only reachable under the mock gateway, which has no escrow contract. The
    // zero address is unmistakable in a record and cannot be confused for a
    // real deployment.
    return "0x0000000000000000000000000000000000000000" as Address;
  }

  /**
   * Turns a payment's token symbol into a contract address.
   *
   * The wallet's own token contract wins when it has one, because that is the
   * address the payee was verified against. Otherwise the symbol is matched to
   * a security this platform issued — which is how a receivable minted through
   * /securities becomes payable without the caller repeating its address.
   */
  private async resolveToken(symbol: string, walletToken: string | null): Promise<Address> {
    if (walletToken) return walletToken as Address;

    // A security this platform issued.
    const security = await this.deps.prisma.security.findFirst({
      where: { symbol },
      orderBy: { createdAt: "desc" },
    });
    if (security) return security.evmAddress as Address;

    // A token somebody else issued — a stablecoin. On Hedera an HTS token is
    // reachable at its own EVM address and answers the ERC-20 interface, which
    // is exactly what the transfer path already calls, so nothing below this
    // point needs to know the difference.
    const configured = this.deps.config.TOKEN_ADDRESSES[symbol.toUpperCase()];
    if (configured) return configured as Address;

    const known = Object.keys(this.deps.config.TOKEN_ADDRESSES);
    throw new UnprocessableError(
      `No token contract for '${symbol}'. Configure it in TOKEN_ADDRESSES` +
        `${known.length ? ` (currently: ${known.join(", ")})` : ""}` +
        ", set the wallet's tokenContract, or issue a security with that symbol.",
    );
  }
}
