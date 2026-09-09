/*
  Warnings:

  - Added the required column `payload` to the `EvidenceRecord` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EvidenceRecord" ADD COLUMN     "payload" JSONB NOT NULL;
