-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "selfieCheckProofRef" TEXT,
    "isNewOrChangedAddress" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_paymentRequestId_key" ON "Proposal"("paymentRequestId");

-- CreateIndex
CREATE INDEX "Proposal_consumedAt_createdAt_idx" ON "Proposal"("consumedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
