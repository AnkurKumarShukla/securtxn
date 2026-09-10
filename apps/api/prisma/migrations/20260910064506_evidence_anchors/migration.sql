-- AlterTable
ALTER TABLE "EvidenceRecord" ADD COLUMN     "anchorId" TEXT;

-- CreateTable
CREATE TABLE "EvidenceAnchor" (
    "id" TEXT NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "topicId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "consensusTimestamp" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "messageUrl" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceAnchor_merkleRoot_key" ON "EvidenceAnchor"("merkleRoot");

-- CreateIndex
CREATE INDEX "EvidenceAnchor_createdAt_idx" ON "EvidenceAnchor"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceAnchor_topicId_sequenceNumber_key" ON "EvidenceAnchor"("topicId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "EvidenceRecord_anchorId_idx" ON "EvidenceRecord"("anchorId");

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_anchorId_fkey" FOREIGN KEY ("anchorId") REFERENCES "EvidenceAnchor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
