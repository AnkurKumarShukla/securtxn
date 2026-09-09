// Vendor creation and KYB status.
//
// Spec: docs/architecture.md §4.1

import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, Vendor } from "@prisma/client";
import type { CreateVendorRequest, CreateVendorResponse, VendorSummary } from "@cp/shared-types";
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

  async get(vendorId: string): Promise<VendorSummary> {
    return toSummary(await this.requireVendor(vendorId));
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
    displayName:
      vendor.legalEntityName ??
      [vendor.legalFirstName, vendor.legalLastName].filter(Boolean).join(" ") ??
      "",
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
