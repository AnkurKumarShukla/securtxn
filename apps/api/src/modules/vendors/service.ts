// Vendor creation and KYB status.
//
// Spec: docs/architecture.md §4.1

import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, Vendor } from "@prisma/client";
import type {
  CreateVendorRequest,
  CreateVendorResponse,
  VendorByAddress,
  VendorList,
  VendorListQuery,
  VendorSummary,
} from "@cp/shared-types";
import type { Config } from "../../config/index.js";
import { hmac } from "../../lib/crypto.js";
import { NotFoundError } from "../../lib/errors.js";

export class VendorService {
  constructor(private readonly deps: { prisma: PrismaClient; config: Config }) {}

  /**
   * Creates a vendor and issues its onboarding nonce.
   *
   * The nonce is generated HERE, server-side, before any identity or wallet
   * artifact exists. Every later step must present this same value: the
   * DigiLocker session, the liveness capture, and the wallet signature. That is
   * what binds three independently-passable checks to one subject (D03).
   *
   * A client-supplied nonce would defeat the whole control, so there is no way
   * to pass one in.
   */
  async create(input: CreateVendorRequest): Promise<CreateVendorResponse> {
    const onboardingSessionNonce = `0x${randomBytes(32).toString("hex")}`;

    const data: Prisma.VendorCreateInput =
      input.payeeType === "INDIVIDUAL"
        ? {
            payeeType: "INDIVIDUAL",
            legalFirstName: input.legalFirstName,
            legalLastName: input.legalLastName,
            country: input.country,
            ...(input.verifiedEmail ? { verifiedEmail: input.verifiedEmail } : {}),
            onboardingSessionNonce,
          }
        : {
            payeeType: "BUSINESS",
            legalEntityName: input.legalEntityName,
            country: input.country,
            ...(input.verifiedEmail ? { verifiedEmail: input.verifiedEmail } : {}),
            // Raw tax id is accepted, hashed, and discarded. It is never stored
            // in a readable form (D06).
            ...(input.taxId ? { taxIdHmac: hmac(input.taxId, this.deps.config.HMAC_PEPPER) } : {}),
            onboardingSessionNonce,
          };

    const vendor = await this.deps.prisma.vendor.create({ data });

    return {
      id: vendor.id,
      payeeType: vendor.payeeType,
      kybStatus: vendor.kybStatus,
      verificationTier: vendor.verificationTier,
      onboardingSessionNonce,
    };
  }

  async updateKybStatus(
    vendorId: string,
    kybStatus: "PENDING" | "VERIFIED" | "REJECTED",
  ): Promise<VendorSummary> {
    await this.requireVendor(vendorId);
    const vendor = await this.deps.prisma.vendor.update({
      where: { id: vendorId },
      data: { kybStatus },
    });
    return toSummary(vendor);
  }

  /**
   * The payee directory.
   *
   * KEYSET PAGING, NOT OFFSET. Vendors are created while somebody is reading
   * the list, and an offset page silently repeats or skips a row when the set
   * shifts underneath it — on a screen whose whole job is "who can I pay", a
   * quietly missing counterparty is the wrong failure. Ordering on
   * (createdAt, id) and cursoring on the last id is stable under inserts.
   *
   * The wallet is fetched as the most recent one per vendor, because that is
   * what decides whether they can be paid at all. Wallets are versioned (D01)
   * and a superseded row is not the one a payment would use.
   */
  async list(query: VendorListQuery): Promise<VendorList> {
    const where: Prisma.VendorWhereInput = {
      ...(query.verificationTier ? { verificationTier: query.verificationTier } : {}),
      ...(query.q
        ? {
            OR: [
              { legalEntityName: { contains: query.q, mode: "insensitive" as const } },
              { legalFirstName: { contains: query.q, mode: "insensitive" as const } },
              { legalLastName: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      // "Payable" is a property of the WALLET, not of the vendor: a fully
      // verified vendor with no confirmed wallet still cannot receive money.
      ...(query.payableOnly ? { wallets: { some: { status: "CONFIRMED" } } } : {}),
    };

    const rows = await this.deps.prisma.vendor.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        wallets: {
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });

    // One row over the limit was fetched purely to learn whether another page
    // exists, without a second count query.
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: page.map((vendor) => {
        const wallet = vendor.wallets[0];
        return {
          id: vendor.id,
          displayName: displayNameOf(vendor),
          payeeType: vendor.payeeType,
          country: vendor.country,
          kybStatus: vendor.kybStatus,
          verificationTier: vendor.verificationTier,
          walletStatus: wallet?.status ?? null,
          // Only surfaced once CONFIRMED. An address on an unconfirmed wallet
          // is an address nobody has proved control of, and putting it in a
          // directory invites someone to pay it.
          payoutAddress: wallet?.status === "CONFIRMED" ? wallet.address : null,
          createdAt: vendor.createdAt.toISOString(),
        };
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async get(vendorId: string): Promise<VendorSummary> {
    return toSummary(await this.requireVendor(vendorId));
  }

  /**
   * Which onboarding a payout address belongs to.
   *
   * The point is recovery. The browser's only pointer to a finished onboarding
   * used to be a vendorId in localStorage, so clearing site data threw away the
   * link to a DigiLocker consent that is still perfectly valid on the server. A
   * connected wallet is the same pointer on every device, and this is what
   * turns it back into a session.
   *
   * PENDING WALLETS COUNT. Restricting this to CONFIRMED would be the safer
   * instinct and the wrong one: someone who got halfway and lost their storage
   * is exactly who needs to find their record again, and refusing them means
   * they start a SECOND vendor for the same address. The caller is told the
   * status and decides; `/internal/identity-registry` remains the endpoint that
   * fails closed, because that one gates transfers.
   */
  async findByAddress(address: string, network?: string): Promise<VendorByAddress> {
    const wallet = await this.deps.prisma.vendorWallet.findFirst({
      where: {
        // EVM addresses are case-insensitive. A checksummed address from a
        // wallet and a lowercased one in the database are the same address, and
        // an exact match would report "no record" for a finished onboarding.
        address: { equals: address, mode: "insensitive" },
        ...(network ? { network } : {}),
        status: { not: "REVOKED" },
      },
      // An address may be re-registered as a later version after revocation;
      // the most recent registration is the current one.
      orderBy: { version: "desc" },
      include: { vendor: true },
    });
    if (!wallet) throw new NotFoundError(`No onboarding for address '${address}'`);

    // The enrolment is looked up separately because it is not a foreign key:
    // WorldIdVerification.subject is a plain string so the table can serve
    // future subject types that are not vendors.
    const enrolment = await this.deps.prisma.worldIdVerification.findFirst({
      where: { subject: wallet.vendorId, purpose: "ENROLLMENT" },
      orderBy: { verifiedAt: "desc" },
      select: { id: true },
    });

    const ttl = wallet.vendor.aadhaarKycTtl;
    return {
      vendorId: wallet.vendorId,
      displayName: displayNameOf(wallet.vendor),
      verificationTier: wallet.vendor.verificationTier,
      // Expiry is part of the answer, not a footnote. A restored session that
      // says "verified" about a lapsed TTL would skip a re-verification the
      // rules require (D06).
      identityVerified:
        wallet.vendor.verificationTier !== "TIER0_UNVERIFIED" &&
        (ttl === null || ttl.getTime() > Date.now()),
      aadhaarKycTtl: ttl?.toISOString() ?? null,
      walletId: wallet.id,
      walletStatus: wallet.status,
      address: wallet.address,
      network: wallet.network as VendorByAddress["network"],
      enrolmentId: enrolment?.id ?? null,
    };
  }

  private async requireVendor(vendorId: string): Promise<Vendor> {
    const vendor = await this.deps.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundError(`Vendor '${vendorId}'`);
    return vendor;
  }
}

/**
 * Projection to the safe read model.
 *
 * Built field by field rather than by spreading the row and deleting: a new
 * PII column added to the schema must be opted IN here, not remembered to be
 * opted out (D27).
 */
export function toSummary(vendor: Vendor): VendorSummary {
  return {
    id: vendor.id,
    payeeType: vendor.payeeType,
    displayName: displayNameOf(vendor),
    country: vendor.country,
    kybStatus: vendor.kybStatus,
    verificationTier: vendor.verificationTier,
    aadhaarLast4: vendor.aadhaarLast4,
    xmlSignatureVerified: vendor.xmlSignatureVerified,
    crossDocConsistent: vendor.crossDocConsistent,
    aadhaarKycTtl: vendor.aadhaarKycTtl?.toISOString() ?? null,
    createdAt: vendor.createdAt.toISOString(),
  };
}

/**
 * A vendor's human-readable name.
 *
 * A business carries one field and an individual carries two, and the list and
 * the summary must not disagree about which to show.
 */
export function displayNameOf(vendor: Vendor): string {
  return (
    vendor.legalEntityName ??
    [vendor.legalFirstName, vendor.legalLastName].filter(Boolean).join(" ") ??
    ""
  );
}
