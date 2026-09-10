-- CreateEnum
CREATE TYPE "SettlementMode" AS ENUM ('DIRECT', 'HTLC');

-- CreateEnum
CREATE TYPE "HtlcStatus" AS ENUM ('LOCKED', 'CLAIMED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AcknowledgmentMethod" AS ENUM ('EIP712_SIGNATURE', 'HTLC_CLAIM');

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "settlementMode" "SettlementMode" NOT NULL DEFAULT 'DIRECT';

-- AlterTable
ALTER TABLE "RecipientAcknowledgment" ADD COLUMN     "claimTxHash" TEXT,
ADD COLUMN     "method" "AcknowledgmentMethod" NOT NULL DEFAULT 'EIP712_SIGNATURE',
ALTER COLUMN "recipientSignature" DROP NOT NULL;

-- CreateTable
CREATE TABLE "HtlcSettlement" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "escrowAddress" TEXT NOT NULL,
    "lockId" TEXT NOT NULL,
    "hashlock" TEXT NOT NULL,
    "timelock" TIMESTAMP(3) NOT NULL,
    "payerAddress" TEXT NOT NULL,
    "payeeAddress" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "status" "HtlcStatus" NOT NULL DEFAULT 'LOCKED',
    "lockTxHash" TEXT NOT NULL,
    "claimTxHash" TEXT,
    "refundTxHash" TEXT,
    "preimage" TEXT,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "HtlcSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HtlcSettlement_paymentRequestId_key" ON "HtlcSettlement"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "HtlcSettlement_lockId_key" ON "HtlcSettlement"("lockId");

-- CreateIndex
CREATE INDEX "HtlcSettlement_status_idx" ON "HtlcSettlement"("status");

-- CreateIndex
CREATE INDEX "HtlcSettlement_timelock_idx" ON "HtlcSettlement"("timelock");

-- AddForeignKey
ALTER TABLE "HtlcSettlement" ADD CONSTRAINT "HtlcSettlement_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
