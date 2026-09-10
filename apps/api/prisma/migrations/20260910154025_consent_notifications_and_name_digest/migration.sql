-- CreateEnum
CREATE TYPE "PayeeConsentDecision" AS ENUM ('ACCEPTED', 'DENIED');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('CONSENT_REQUESTED', 'IDENTITY_MISMATCH', 'FUNDS_LOCKED');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'AWAITING_PAYEE_CONSENT';

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "payerVendorId" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "legalNameHmac" TEXT;

-- CreateTable
CREATE TABLE "PayeeConsent" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "decision" "PayeeConsentDecision" NOT NULL,
    "signature" TEXT,
    "signerAddress" TEXT,
    "worldIdVerificationId" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayeeConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "paymentRequestId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityBlock" (
    "id" TEXT NOT NULL,
    "blockedByVendorId" TEXT NOT NULL,
    "blockedVendorId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayeeConsent_paymentRequestId_key" ON "PayeeConsent"("paymentRequestId");

-- CreateIndex
CREATE INDEX "PayeeConsent_decision_decidedAt_idx" ON "PayeeConsent"("decision", "decidedAt");

-- CreateIndex
CREATE INDEX "Notification_vendorId_readAt_createdAt_idx" ON "Notification"("vendorId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityBlock_blockedByVendorId_blockedVendorId_key" ON "IdentityBlock"("blockedByVendorId", "blockedVendorId");

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_payerVendorId_fkey" FOREIGN KEY ("payerVendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayeeConsent" ADD CONSTRAINT "PayeeConsent_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityBlock" ADD CONSTRAINT "IdentityBlock_blockedByVendorId_fkey" FOREIGN KEY ("blockedByVendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityBlock" ADD CONSTRAINT "IdentityBlock_blockedVendorId_fkey" FOREIGN KEY ("blockedVendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
