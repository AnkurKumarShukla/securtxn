/*
  Warnings:

  - Added the required column `onChainAmount` to the `HtlcSettlement` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenAddress` to the `HtlcSettlement` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "HtlcSettlement" ADD COLUMN     "onChainAmount" TEXT NOT NULL,
ADD COLUMN     "tokenAddress" TEXT NOT NULL;
