-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('PENDING_VERIFICATION', 'CONFIRMED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PaymentDecision" AS ENUM ('SAFE_TO_SEND', 'DO_NOT_SEND', 'REVERIFY', 'SEND_TEST_AMOUNT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('DRAFT', 'DECISION_PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'CONFIRMED_ON_CHAIN', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('OVERPAY', 'MISDIRECT', 'DUPLICATE', 'WRONG_ASSET', 'DISPUTE');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'IN_RECOVERY', 'RESOLVED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "PayeeType" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "VerificationTier" AS ENUM ('TIER0_UNVERIFIED', 'TIER1_LIVENESS', 'TIER2_IDENTITY', 'TIER3_ADDRESS');

-- CreateEnum
CREATE TYPE "KybStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PhoneLineType" AS ENUM ('MOBILE', 'LANDLINE', 'VOIP');

-- CreateEnum
CREATE TYPE "AddressVerifiedMethod" AS ENUM ('POSTCARD_CODE', 'ID_DOCUMENT', 'DATABASE_LOOKUP', 'UNVERIFIED');

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "payeeType" "PayeeType" NOT NULL,
    "verificationTier" "VerificationTier" NOT NULL DEFAULT 'TIER0_UNVERIFIED',
    "legalFirstName" TEXT,
    "legalLastName" TEXT,
    "dobEncrypted" TEXT,
    "idDocumentCheckRef" TEXT,
    "idDocumentType" TEXT,
    "faceMatchScore" DOUBLE PRECISION,
    "worldIdSelfieCheckRef" TEXT,
    "digilockerUserId" TEXT,
    "digilockerSessionId" TEXT,
    "aadhaarLast4" TEXT,
    "aadhaarKycTtl" TIMESTAMP(3),
    "panNumberHmac" TEXT,
    "panVerifiedOn" TIMESTAMP(3),
    "photoEncryptedRef" TEXT,
    "xmlSignatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "xmlSignatureVerifiedAt" TIMESTAMP(3),
    "crossDocConsistent" BOOLEAN NOT NULL DEFAULT false,
    "legalEntityName" TEXT,
    "taxIdHmac" TEXT,
    "registryVerifiedName" TEXT,
    "registryVerifiedContact" TEXT,
    "country" TEXT NOT NULL,
    "verifiedPhone" TEXT,
    "verifiedPhoneAt" TIMESTAMP(3),
    "phoneLineType" "PhoneLineType",
    "verifiedEmail" TEXT,
    "verifiedAddressEncrypted" JSONB,
    "addressVerifiedMethod" "AddressVerifiedMethod",
    "addressVerifiedAt" TIMESTAMP(3),
    "attestationSig" TEXT,
    "attestationDataHash" TEXT,
    "attestedAt" TIMESTAMP(3),
    "onboardingSessionNonce" TEXT,
    "kybStatus" "KybStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorWallet" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "tokenContract" TEXT,
    "version" INTEGER NOT NULL,
    "supersededById" TEXT,
    "status" "WalletStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "controlProofSig" TEXT,
    "controlProofNonce" TEXT,
    "callbackConfirmedAt" TIMESTAMP(3),
    "callbackChannelUsed" TEXT,
    "callbackConfirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorWalletId" TEXT NOT NULL,
    "invoiceRef" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "token" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "senderContextCommitment" TEXT NOT NULL,
    "decision" "PaymentDecision",
    "decisionReasonCode" TEXT,
    "matchScore" DOUBLE PRECISION,
    "status" "PaymentStatus" NOT NULL DEFAULT 'DRAFT',
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalEvent" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "selfieCheckVerified" BOOLEAN NOT NULL DEFAULT false,
    "selfieCheckProofRef" TEXT,
    "ledgerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "ledgerConfirmedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientAcknowledgment" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "recipientSignature" TEXT NOT NULL,
    "recipientCommitment" TEXT NOT NULL,
    "rawContextEncryptedRef" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipientAcknowledgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionCase" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "playbookSteps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ExceptionCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRecord" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "previousRecordHash" TEXT NOT NULL,
    "hcsAnchorTxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_digilockerUserId_key" ON "Vendor"("digilockerUserId");

-- CreateIndex
CREATE INDEX "Vendor_kybStatus_idx" ON "Vendor"("kybStatus");

-- CreateIndex
CREATE UNIQUE INDEX "VendorWallet_supersededById_key" ON "VendorWallet"("supersededById");

-- CreateIndex
CREATE INDEX "VendorWallet_vendorId_version_idx" ON "VendorWallet"("vendorId", "version");

-- CreateIndex
CREATE INDEX "VendorWallet_address_network_idx" ON "VendorWallet"("address", "network");

-- CreateIndex
CREATE UNIQUE INDEX "VendorWallet_vendorId_version_key" ON "VendorWallet"("vendorId", "version");

-- CreateIndex
CREATE INDEX "PaymentRequest_vendorId_createdAt_idx" ON "PaymentRequest"("vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_status_idx" ON "PaymentRequest"("status");

-- CreateIndex
CREATE INDEX "PaymentRequest_txHash_idx" ON "PaymentRequest"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalEvent_paymentRequestId_key" ON "ApprovalEvent"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientAcknowledgment_paymentRequestId_key" ON "RecipientAcknowledgment"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ExceptionCase_paymentRequestId_key" ON "ExceptionCase"("paymentRequestId");

-- CreateIndex
CREATE INDEX "ExceptionCase_status_idx" ON "ExceptionCase"("status");

-- CreateIndex
CREATE INDEX "EvidenceRecord_paymentRequestId_createdAt_idx" ON "EvidenceRecord"("paymentRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceRecord_hcsAnchorTxId_idx" ON "EvidenceRecord"("hcsAnchorTxId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_paymentRequestId_previousRecordHash_key" ON "EvidenceRecord"("paymentRequestId", "previousRecordHash");

-- AddForeignKey
ALTER TABLE "VendorWallet" ADD CONSTRAINT "VendorWallet_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorWallet" ADD CONSTRAINT "VendorWallet_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "VendorWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_vendorWalletId_fkey" FOREIGN KEY ("vendorWalletId") REFERENCES "VendorWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalEvent" ADD CONSTRAINT "ApprovalEvent_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientAcknowledgment" ADD CONSTRAINT "RecipientAcknowledgment_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionCase" ADD CONSTRAINT "ExceptionCase_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
