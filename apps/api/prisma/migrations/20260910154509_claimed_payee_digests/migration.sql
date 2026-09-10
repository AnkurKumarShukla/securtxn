-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "claimedPayeeNameHmac" TEXT,
ADD COLUMN     "claimedPayeePanHmac" TEXT;
