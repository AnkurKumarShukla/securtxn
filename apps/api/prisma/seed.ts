// Seed: one Vendor -> one CONFIRMED VendorWallet -> one PaymentRequest.
//
// Idempotent: re-running updates the same fixed ids rather than accumulating
// duplicates, so `pnpm --filter @cp/api seed` is safe to repeat.
//
// Spec: docs/architecture.md §3 acceptance criteria

import { PrismaClient } from "@prisma/client";
import { loadConfig } from "../src/config/index.js";
import { issueCredential, type CredentialClaims } from "../src/lib/vc.js";

// Reuse the app's config loader rather than reading process.env directly: it
// finds the repo-root .env from any cwd and validates it the same way the
// server does, so the seed cannot run against a half-configured environment.
const config = loadConfig();
const prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });

// Fixed ids so the seed is idempotent and so tests/docs can reference a known row.
const VENDOR_ID = "00000000-0000-4000-8000-000000000001";
const WALLET_ID = "00000000-0000-4000-8000-000000000002";
const PAYMENT_ID = "00000000-0000-4000-8000-000000000003";

/**
 * Hardcoded on purpose. This is the contact an operator must dial to confirm a
 * wallet, and it stands in for an independent business-registry lookup. Leaving
 * it null would let `callback-confirm` pass trivially in a demo and hide the
 * control that stops an attacker confirming their own submitted number (D05).
 */
const REGISTRY_VERIFIED_CONTACT = "+91-22-5550-0100";

async function main(): Promise<void> {
  const vendor = await prisma.vendor.upsert({
    where: { id: VENDOR_ID },
    update: {},
    create: {
      id: VENDOR_ID,
      payeeType: "BUSINESS",
      // Seeded as if a full DigiLocker flow had completed: identity + address
      // from the Aadhaar Poa is what reaches TIER3 in one step (§4.7).
      verificationTier: "TIER3_ADDRESS",
      legalEntityName: "Meridian Components Pvt Ltd",
      registryVerifiedName: "MERIDIAN COMPONENTS PRIVATE LIMITED",
      registryVerifiedContact: REGISTRY_VERIFIED_CONTACT,
      kybStatus: "VERIFIED",
      country: "IN",
      phoneLineType: "LANDLINE",
      addressVerifiedMethod: "ID_DOCUMENT",
      addressVerifiedAt: new Date("2026-09-08T00:00:00Z"),
      // Both must be true before a wallet may reach CONFIRMED (D04). Set here
      // because the seed skips the identity flow, not because they are optional.
      xmlSignatureVerified: true,
      xmlSignatureVerifiedAt: new Date("2026-09-08T00:00:00Z"),
      crossDocConsistent: true,
      aadhaarKycTtl: new Date("2027-09-03T04:10:04Z"),
      onboardingSessionNonce: "0x" + "11".repeat(32),
    },
  });

  const wallet = await prisma.vendorWallet.upsert({
    where: { id: WALLET_ID },
    update: {},
    create: {
      id: WALLET_ID,
      vendorId: vendor.id,
      address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      network: "ethereum",
      tokenContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      version: 1,
      status: "CONFIRMED",
      controlProofSig: "0x" + "22".repeat(65),
      controlProofNonce: "0x" + "11".repeat(32), // same nonce as the vendor (D03)
      // The callback was placed to the registry contact, not to anything the
      // vendor submitted — which is the whole point of the control.
      callbackChannelUsed: REGISTRY_VERIFIED_CONTACT,
      callbackConfirmedBy: "seed-operator",
      callbackConfirmedAt: new Date("2026-09-08T00:00:00Z"),
      confirmedAt: new Date("2026-09-08T00:00:00Z"),
    },
  });

  const payment = await prisma.paymentRequest.upsert({
    where: { id: PAYMENT_ID },
    update: {},
    create: {
      id: PAYMENT_ID,
      vendorId: vendor.id,
      vendorWalletId: wallet.id,
      invoiceRef: "INV-2026-0912",
      amount: "12500.500000000000000000",
      token: "USDC",
      network: "ethereum",
      senderContextCommitment: "0x" + "33".repeat(32),
      status: "DRAFT",
    },
  });

  // The seed writes a CONFIRMED wallet directly rather than walking
  // callback-confirm, so the credential that step normally mints has to be
  // created here too — otherwise the seeded state looks confirmed but cannot
  // be granted KYC on chain (D42).
  if (config.ATS_ISSUER_PRIVATE_KEY) {
    const claims: CredentialClaims = {
      providerUserId: "8ae4e10fc82d9e0d3852c60fc0a15c51",
      verificationTier: vendor.verificationTier,
      xmlSignatureVerified: true,
      crossDocConsistent: true,
      sameSubjectLinked: true,
      walletControlProven: true,
      identityBindingSigned: true,
      callbackConfirmed: true,
      addressVerifiedMethod: "ID_DOCUMENT",
      country: vendor.country,
      onboardingSessionNonce: vendor.onboardingSessionNonce ?? "",
    };

    const credentialId = "00000000-0000-4000-8000-0000000000c1";
    const issued = await issueCredential({
      credentialId,
      subjectAddress: wallet.address,
      claims,
      issuedAt: new Date("2026-09-08T00:00:00Z"),
      expiresAt: vendor.aadhaarKycTtl,
      chainId: config.HEDERA_CHAIN_ID,
      issuerPrivateKey: config.ATS_ISSUER_PRIVATE_KEY,
    });

    await prisma.verifiableCredential.upsert({
      where: { id: credentialId },
      update: { issuerAddress: issued.issuerAddress, signature: issued.signature },
      create: {
        id: credentialId,
        vendorId: vendor.id,
        walletId: wallet.id,
        subjectAddress: wallet.address,
        claims: issued.claims as object,
        signature: issued.signature,
        issuerAddress: issued.issuerAddress,
        issuedAt: issued.issuedAt,
        ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
      },
    });
    console.log(`  credential ${credentialId} issued by ${issued.issuerAddress}`);
  }

  console.log("Seeded:");
  console.log(`  vendor  ${vendor.id}  ${vendor.legalEntityName} (${vendor.verificationTier})`);
  console.log(`  wallet  ${wallet.id}  ${wallet.address} v${wallet.version} ${wallet.status}`);
  console.log(`  payment ${payment.id}  ${payment.invoiceRef} ${payment.amount} ${payment.token}`);
  console.log("\nNo EvidenceRecord is seeded: the chain starts at genesis when the");
  console.log("first real state change happens, and a fabricated record would be a");
  console.log("hash-chain entry nothing actually produced (D07).");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
