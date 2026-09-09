-- CreateEnum
CREATE TYPE "WorldIdPurpose" AS ENUM ('ENROLLMENT', 'REVERIFICATION');

-- CreateTable
CREATE TABLE "WorldIdVerification" (
    "id" TEXT NOT NULL,
    "nullifier" DECIMAL(78,0) NOT NULL,
    "action" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "purpose" "WorldIdPurpose" NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "upstreamReuse" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorldIdVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorldIdVerification_subject_purpose_verifiedAt_idx" ON "WorldIdVerification"("subject", "purpose", "verifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorldIdVerification_nullifier_action_signal_key" ON "WorldIdVerification"("nullifier", "action", "signal");
