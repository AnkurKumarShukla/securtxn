-- CreateTable
CREATE TABLE "VerifiableCredential" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "subjectAddress" TEXT NOT NULL,
    "claims" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "issuerAddress" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "grantedTxHash" TEXT,

    CONSTRAINT "VerifiableCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerifiableCredential_walletId_key" ON "VerifiableCredential"("walletId");

-- CreateIndex
CREATE INDEX "VerifiableCredential_subjectAddress_idx" ON "VerifiableCredential"("subjectAddress");

-- CreateIndex
CREATE INDEX "VerifiableCredential_revokedAt_expiresAt_idx" ON "VerifiableCredential"("revokedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "VerifiableCredential" ADD CONSTRAINT "VerifiableCredential_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerifiableCredential" ADD CONSTRAINT "VerifiableCredential_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "VendorWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
