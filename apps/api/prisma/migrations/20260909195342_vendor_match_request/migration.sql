-- CreateEnum
CREATE TYPE "VendorMatchRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "VendorMatchRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "VendorMatchRequestStatus" NOT NULL DEFAULT 'PENDING',
    "match" BOOLEAN,
    "score" DOUBLE PRECISION,
    "reasonCode" TEXT,
    "workflowExecutionId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VendorMatchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorMatchRequest_vendorId_createdAt_idx" ON "VendorMatchRequest"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "VendorMatchRequest_status_createdAt_idx" ON "VendorMatchRequest"("status", "createdAt");
