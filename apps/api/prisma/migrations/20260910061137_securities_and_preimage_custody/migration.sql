-- CreateEnum
CREATE TYPE "SecurityStatus" AS ENUM ('ISSUED', 'MATURED');

-- CreateEnum
CREATE TYPE "SecurityEventKind" AS ENUM ('ISSUED', 'PREPARED', 'MINTED', 'TRANSFERRED', 'COUPON_SET', 'MATURITY_UPDATED', 'REDEEMED');

-- AlterEnum
ALTER TYPE "BlobKind" ADD VALUE 'HTLC_PREIMAGE';

-- AlterTable
ALTER TABLE "HtlcSettlement" ADD COLUMN     "preimageEncryptedRef" TEXT,
ADD COLUMN     "preimageReleasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Security" (
    "id" TEXT NOT NULL,
    "evmAddress" TEXT NOT NULL,
    "hederaId" TEXT,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "isin" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 2,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "nominalValue" DECIMAL(38,18) NOT NULL,
    "nominalValueDecimals" INTEGER NOT NULL DEFAULT 2,
    "maxSupply" TEXT NOT NULL,
    "startingDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "status" "SecurityStatus" NOT NULL DEFAULT 'ISSUED',
    "issuerRegistered" BOOLEAN NOT NULL DEFAULT false,
    "deployTxHash" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Security_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "kind" "SecurityEventKind" NOT NULL,
    "txHash" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Security_evmAddress_key" ON "Security"("evmAddress");

-- CreateIndex
CREATE INDEX "Security_status_idx" ON "Security"("status");

-- CreateIndex
CREATE INDEX "SecurityEvent_securityId_createdAt_idx" ON "SecurityEvent"("securityId", "createdAt");

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HtlcSettlement" ADD CONSTRAINT "HtlcSettlement_preimageEncryptedRef_fkey" FOREIGN KEY ("preimageEncryptedRef") REFERENCES "EncryptedBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
