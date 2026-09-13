-- AlterEnum
ALTER TYPE "HtlcStatus" ADD VALUE 'PENDING_LOCK';

-- AlterTable
ALTER TABLE "HtlcSettlement" ALTER COLUMN "lockTxHash" DROP NOT NULL;
