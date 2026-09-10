// A minimal paying party for tests.
//
// Both sides of a payment onboard through the same path, so the payer is a
// Vendor too (D62 flow, O1-O8). Flow tests care about the payee's verification,
// not the payer's, so this creates the least a payment needs: a distinct
// vendor row to point `payerVendorId` at.
//
// Deliberately NOT the payee. Using one vendor for both sides would make a
// payment self-referential and could hide a bug where the two are confused —
// which is exactly the class of bug that made the old identity match compare a
// record to itself.

import type { PrismaClient } from "@prisma/client";

/** Creates a payer and returns its id. Track it for teardown. */
export async function createPayer(prisma: PrismaClient, label = "payer"): Promise<string> {
  const payer = await prisma.vendor.create({
    data: {
      payeeType: "BUSINESS",
      legalEntityName: `${label} ${Date.now()}`,
      country: "IN",
    },
    select: { id: true },
  });
  return payer.id;
}
