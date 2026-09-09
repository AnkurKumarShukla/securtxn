// Prisma-backed VendorMatchRequestStore.
//
// This is the half of the CRE exchange that has to know about the database.
// It lives here rather than in @cp/cre-workflows because that package must not
// depend on Prisma — the same code has to be able to run inside a TEE (D09).
//
// Spec: docs/decisions.md D48

import type { VendorMatchRequestStore } from "./CreVendorMatcher.js";
import type { PrismaClient } from "@prisma/client";

export function createVendorMatchRequestStore(prisma: PrismaClient): VendorMatchRequestStore {
  return {
    async create(input) {
      const row = await prisma.vendorMatchRequest.create({
        data: {
          vendorId: input.vendorId,
          walletAddress: input.walletAddress,
          network: input.network,
        },
        select: { id: true },
      });
      return row.id;
    },

    async attachExecution(requestId, executionId) {
      await prisma.vendorMatchRequest.update({
        where: { id: requestId },
        data: { workflowExecutionId: executionId },
      });
    },

    async get(requestId) {
      return prisma.vendorMatchRequest.findUnique({
        where: { id: requestId },
        select: {
          status: true,
          match: true,
          score: true,
          reasonCode: true,
          failureReason: true,
        },
      });
    },

    async fail(requestId, reason) {
      // updateMany, not update: a callback may have landed between the poll
      // and this write, and overwriting a real verdict with "timed out" would
      // discard the answer we were waiting for. The status guard makes the
      // late verdict win, which is the correct outcome.
      await prisma.vendorMatchRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: { status: "FAILED", failureReason: reason, completedAt: new Date() },
      });
    },
  };
}
