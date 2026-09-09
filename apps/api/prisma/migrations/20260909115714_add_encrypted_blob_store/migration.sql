-- CreateEnum
CREATE TYPE "BlobKind" AS ENUM ('IDENTITY_PHOTO', 'ACK_CONTEXT');

-- CreateTable
CREATE TABLE "EncryptedBlob" (
    "id" TEXT NOT NULL,
    "kind" "BlobKind" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EncryptedBlob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EncryptedBlob_kind_idx" ON "EncryptedBlob"("kind");

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_photoEncryptedRef_fkey" FOREIGN KEY ("photoEncryptedRef") REFERENCES "EncryptedBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientAcknowledgment" ADD CONSTRAINT "RecipientAcknowledgment_rawContextEncryptedRef_fkey" FOREIGN KEY ("rawContextEncryptedRef") REFERENCES "EncryptedBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
