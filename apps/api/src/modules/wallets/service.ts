// Wallet registration, control proof, identity binding, and confirmation.
//
// Three separate gates stand between "an address was submitted" and CONFIRMED,
// and each proves something the others do not:
//
//   1. control proof     the signer holds this key
//   2. identity binding  the verified identity claims this key, under the same
//                        onboarding nonce
//   3. callback          a human reached the payee on an independent channel
//
// All three, or the wallet stays PENDING_VERIFICATION.
//
// Spec: docs/architecture.md §4.1, §4.7

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type Vendor, type VendorWallet } from "@prisma/client";
import type {
  CallbackConfirmRequest,
  CredentialResponse,
  RegisterWalletRequest,
  RegisterWalletResponse,
  WalletSummary,
} from "@cp/shared-types";
import type { Config } from "../../config/index.js";
import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from "../../lib/errors.js";
import { decrypt } from "../../lib/crypto.js";
import {
  buildIdentityBindingMessage,
  buildWalletControlMessage,
  verifyIdentityBinding,
  verifyWalletControl,
} from "../../lib/eip712.js";
import { checkCallbackChannel } from "./callback-guard.js";
import type { ComplianceGateway } from "@cp/contracts";
import { issueCredential, isUsable, type CredentialClaims } from "../../lib/vc.js";

export class WalletService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      config: Config;
      compliance: ComplianceGateway;
    },
  ) {}

  /**
   * Registers a new wallet version.
   *
   * Versions are append-only: rotating supersedes the previous row rather than
   * updating it, so "which address was CONFIRMED on date X" stays answerable
   * after an incident (D01).
   */
  async register(vendorId: string, input: RegisterWalletRequest): Promise<RegisterWalletResponse> {
    const vendor = await this.requireVendor(vendorId);

    if (!vendor.onboardingSessionNonce) {
      throw new UnprocessableError(
        "Vendor has no onboarding nonce; it must be created through POST /vendors",
      );
    }

    const latest = await this.deps.prisma.vendorWallet.findFirst({
      where: { vendorId },
      orderBy: { version: "desc" },
    });

    const wallet = await this.deps.prisma.vendorWallet.create({
      data: {
        vendorId,
        address: input.address,
        network: input.network,
        ...(input.tokenContract ? { tokenContract: input.tokenContract } : {}),
        version: (latest?.version ?? 0) + 1,
        // The SAME nonce as the identity artifacts. Not a fresh one — a
        // per-wallet nonce would prove nothing about who the identity belongs
        // to (D03).
        controlProofNonce: vendor.onboardingSessionNonce,
      },
    });

    return {
      walletId: wallet.id,
      version: wallet.version,
      status: wallet.status,
      challengeMessage: describeChallenge(vendor, wallet),
      controlProofNonce: vendor.onboardingSessionNonce,
    };
  }

  /**
   * Verifies the EIP-712 control proof.
   *
   * Proves KEY CUSTODY ONLY. A thief holding a stolen key signs this correctly,
   * which is why it does not advance the wallet's status on its own.
   */
  async submitControlProof(
    vendorId: string,
    walletId: string,
    signature: string,
  ): Promise<WalletSummary> {
    const { vendor, wallet } = await this.requirePair(vendorId, walletId);

    if (!wallet.controlProofNonce) {
      throw new UnprocessableError("Wallet has no control-proof nonce");
    }

    const valid = await verifyWalletControl({
      chainId: this.deps.config.EIP712_CHAIN_ID,
      // The claimed address is an INPUT: the signature either recovers to it or
      // this fails. Never trust a client-asserted signer (§5).
      address: wallet.address,
      signature,
      message: buildWalletControlMessage({
        vendorId: vendor.id,
        walletAddress: wallet.address,
        network: wallet.network,
        nonce: wallet.controlProofNonce,
      }),
    });

    if (!valid) {
      throw new UnprocessableError("Signature does not recover to the claimed wallet address");
    }

    const updated = await this.deps.prisma.vendorWallet.update({
      where: { id: walletId },
      data: { controlProofSig: signature },
    });

    return toWalletSummary(updated);
  }

  /**
   * Verifies the IdentityBinding attestation.
   *
   * This is the step that turns three independent facts into one subject. The
   * payee signs over the onboarding nonce, their DigiLocker user id, the wallet
   * address and both document hashes — so the signature cannot be replayed
   * against a different onboarding attempt, a different identity, or a
   * different set of documents (D03).
   */
  async submitIdentityBinding(
    vendorId: string,
    walletId: string,
    signature: string,
  ): Promise<WalletSummary> {
    const { vendor, wallet } = await this.requirePair(vendorId, walletId);

    if (!vendor.digilockerUserId || !vendor.aadhaarDocHash || !vendor.panDocHash) {
      throw new UnprocessableError(
        "Identity verification must complete before a wallet can be bound to it",
      );
    }
    if (!vendor.onboardingSessionNonce) {
      throw new UnprocessableError("Vendor has no onboarding nonce");
    }

    // The nonce equality check, made explicit rather than implied. If the
    // wallet was created under a different nonce than the identity, the
    // artifacts may belong to different people — reject (D03).
    if (wallet.controlProofNonce !== vendor.onboardingSessionNonce) {
      throw new UnprocessableError(
        "Wallet and identity carry different onboarding nonces; they may belong to different people",
      );
    }

    const valid = await verifyIdentityBinding({
      chainId: this.deps.config.EIP712_CHAIN_ID,
      address: wallet.address,
      signature,
      message: buildIdentityBindingMessage({
        onboardingSessionNonce: vendor.onboardingSessionNonce,
        digilockerUserId: vendor.digilockerUserId,
        walletAddress: wallet.address,
        aadhaarDocHash: vendor.aadhaarDocHash,
        panDocHash: vendor.panDocHash,
      }),
    });

    if (!valid) {
      throw new UnprocessableError("Attestation does not recover to the claimed wallet address");
    }

    await this.deps.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        attestationSig: signature,
        attestationDataHash: vendor.onboardingSessionNonce,
        attestedAt: new Date(),
      },
    });

    return toWalletSummary(wallet);
  }

  /**
   * The final gate. Only this may set CONFIRMED, and only when every earlier
   * proof is already in place.
   */
  async confirmCallback(
    vendorId: string,
    walletId: string,
    input: CallbackConfirmRequest,
  ): Promise<WalletSummary> {
    const { vendor, wallet } = await this.requirePair(vendorId, walletId);

    if (wallet.status === "CONFIRMED") {
      throw new ConflictError("Wallet is already confirmed");
    }
    if (wallet.status === "REVOKED") {
      throw new ConflictError("Wallet is revoked");
    }
    if (!wallet.controlProofSig) {
      throw new UnprocessableError("Wallet control proof has not been submitted");
    }
    if (!vendor.attestationSig) {
      throw new UnprocessableError("Identity binding attestation has not been submitted");
    }
    // An identity that failed its checks can never back a confirmed wallet (D04).
    if (!vendor.xmlSignatureVerified || !vendor.crossDocConsistent) {
      throw new UnprocessableError("Vendor identity is not verified");
    }

    const check = checkCallbackChannel({
      vendor,
      wallet,
      channelUsed: input.channelUsed,
      decryptedVerifiedPhone: this.decryptPhone(vendor),
    });

    if (!check.allowed) {
      // 400: the operator supplied a channel we will not accept. This is the
      // control that stops an attacker confirming their own submitted number.
      throw new BadRequestError(check.reason);
    }

    const now = new Date();
    const updated = await this.deps.prisma.vendorWallet.update({
      where: { id: walletId },
      data: {
        status: "CONFIRMED",
        confirmedAt: now,
        callbackConfirmedAt: now,
        callbackConfirmedBy: input.confirmedBy,
        callbackChannelUsed: input.channelUsed,
      },
    });

    // The wallet is now verified end to end, so mint the credential that makes
    // an on-chain KYC grant meaningful (D42). Issued here rather than at grant
    // time so the credential records what was true at confirmation.
    await this.issueVerificationCredential(vendor, updated);

    return toWalletSummary(updated);
  }

  /**
   * Mints the verifiable credential for a freshly confirmed wallet.
   *
   * Never throws into the confirmation path: a credential is a downstream
   * artifact, and failing to mint one must not undo a wallet confirmation that
   * genuinely passed all three gates. An absent credential simply means the
   * on-chain grant has nothing to reference yet.
   */
  private async issueVerificationCredential(
    vendor: Vendor,
    wallet: VendorWallet,
  ): Promise<void> {
    const issuerKey = this.deps.config.ATS_ISSUER_PRIVATE_KEY;
    if (!issuerKey) return; // fails closed: no key, no unsigned credential

    const claims: CredentialClaims = {
      providerUserId: vendor.digilockerUserId ?? "",
      verificationTier: vendor.verificationTier,
      xmlSignatureVerified: vendor.xmlSignatureVerified,
      crossDocConsistent: vendor.crossDocConsistent,
      // Linkage is implied by a populated digilockerUserId: the service only
      // writes it when the Aadhaar txn id and PAN Person@uid agree (D02).
      sameSubjectLinked: vendor.digilockerUserId !== null,
      walletControlProven: wallet.controlProofSig !== null,
      identityBindingSigned: vendor.attestationSig !== null,
      callbackConfirmed: wallet.callbackConfirmedAt !== null,
      addressVerifiedMethod: vendor.addressVerifiedMethod ?? "UNVERIFIED",
      country: vendor.country,
      onboardingSessionNonce: vendor.onboardingSessionNonce ?? "",
    };

    const credentialId = randomUUID();
    const issued = await issueCredential({
      credentialId,
      subjectAddress: wallet.address,
      claims,
      issuedAt: new Date(),
      // Verification is time-bounded, so the credential is too. This becomes
      // the on-chain validTo, and a stale identity expires without anyone
      // remembering to act (D06, D42).
      expiresAt: vendor.aadhaarKycTtl,
      chainId: this.deps.config.HEDERA_CHAIN_ID,
      issuerPrivateKey: issuerKey,
    });

    await this.deps.prisma.verifiableCredential.create({
      data: {
        id: credentialId,
        vendorId: vendor.id,
        walletId: wallet.id,
        subjectAddress: wallet.address,
        claims: issued.claims as unknown as Prisma.InputJsonValue,
        signature: issued.signature,
        issuerAddress: issued.issuerAddress,
        issuedAt: issued.issuedAt,
        ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
      },
    });
  }

  /**
   * The credential minted at confirmation.
   *
   * Returned in full because it is safe to disclose in full: every claim is a
   * boolean, an enum, or an opaque identifier, and the chain will reference it
   * publicly anyway (D42).
   */
  async getCredential(vendorId: string, walletId: string): Promise<CredentialResponse> {
    await this.requirePair(vendorId, walletId);

    const credential = await this.deps.prisma.verifiableCredential.findUnique({
      where: { walletId },
    });
    if (!credential) {
      throw new NotFoundError(`Credential for wallet '${walletId}'`);
    }

    return {
      credentialId: credential.id,
      subjectAddress: credential.subjectAddress as CredentialResponse["subjectAddress"],
      claims: credential.claims as unknown as CredentialResponse["claims"],
      signature: credential.signature,
      issuerAddress: credential.issuerAddress as CredentialResponse["issuerAddress"],
      issuedAt: credential.issuedAt.toISOString(),
      expiresAt: credential.expiresAt?.toISOString() ?? null,
      revokedAt: credential.revokedAt?.toISOString() ?? null,
      grantedTxHash: credential.grantedTxHash,
      // Computed, never stored: a cached "usable" flag goes stale the moment
      // the expiry passes, and this gates an on-chain grant.
      usable: isUsable(credential),
    };
  }

  /**
   * Grants KYC on the ATS security, so the token itself will accept transfers
   * to this wallet.
   *
   * A SEPARATE, RETRYABLE step rather than part of callback-confirm. Vendor
   * onboarding must not depend on a chain being reachable: an RPC outage or a
   * security that has not been issued yet would otherwise block a verification
   * that is complete and correct off-chain.
   */
  async grantOnChainKyc(vendorId: string, walletId: string): Promise<{
    txHash: string;
    broadcast: boolean;
    credentialId: string;
    securityId: string;
  }> {
    const { wallet } = await this.requirePair(vendorId, walletId);

    if (wallet.status !== "CONFIRMED") {
      throw new UnprocessableError(
        `Wallet is '${wallet.status}'; only a CONFIRMED wallet may be granted KYC`,
      );
    }

    const securityId = this.deps.config.ATS_SECURITY_ID;
    if (!securityId) {
      throw new UnprocessableError(
        "ATS_SECURITY_ID is not set; issue a security before granting KYC against it",
      );
    }

    const credential = await this.deps.prisma.verifiableCredential.findUnique({
      where: { walletId },
    });
    if (!credential) {
      throw new NotFoundError(`Credential for wallet '${walletId}'`);
    }
    // The platform's own gate, checked before asking the chain: granting an
    // expired or revoked credential would put a stale assertion on chain with
    // a validity window that has already passed.
    if (!isUsable(credential)) {
      throw new UnprocessableError("Credential is expired or revoked; re-verify before granting");
    }
    if (credential.grantedTxHash) {
      throw new ConflictError("KYC has already been granted for this wallet");
    }

    // The issuer recorded on chain must be the key that signed the credential,
    // or a verifier cannot connect the two.
    const gatewayIssuer = this.deps.compliance.issuerAddress().toLowerCase();
    if (credential.issuerAddress.toLowerCase() !== gatewayIssuer) {
      throw new UnprocessableError(
        "Credential issuer does not match the configured on-chain issuer key",
      );
    }

    const result = await this.deps.compliance.grantKyc({
      securityId,
      account: wallet.address,
      vcId: credential.id,
      validFrom: credential.issuedAt,
      validTo: credential.expiresAt,
    });

    await this.deps.prisma.verifiableCredential.update({
      where: { id: credential.id },
      data: { grantedTxHash: result.txHash },
    });

    return {
      txHash: result.txHash,
      broadcast: result.broadcast,
      credentialId: credential.id,
      securityId,
    };
  }

  async list(vendorId: string): Promise<WalletSummary[]> {
    await this.requireVendor(vendorId);
    const wallets = await this.deps.prisma.vendorWallet.findMany({
      where: { vendorId },
      orderBy: { version: "asc" },
    });
    return wallets.map(toWalletSummary);
  }

  /** Stored encrypted; decrypted only to compare, never returned to a caller. */
  private decryptPhone(vendor: Vendor): string | null {
    if (!vendor.verifiedPhone) return null;
    try {
      const [iv = "", authTag = "", ciphertext = ""] = vendor.verifiedPhone.split(".");
      return decrypt(
        {
          iv: Buffer.from(iv, "base64"),
          authTag: Buffer.from(authTag, "base64"),
          ciphertext: Buffer.from(ciphertext, "base64"),
        },
        this.deps.config.PII_ENCRYPTION_KEY,
      ).toString("utf8");
    } catch {
      // A phone we cannot decrypt is a phone we cannot verify against. Treat it
      // as absent so the guard fails closed rather than matching on garbage.
      return null;
    }
  }

  private async requireVendor(vendorId: string): Promise<Vendor> {
    const vendor = await this.deps.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundError(`Vendor '${vendorId}'`);
    return vendor;
  }

  private async requirePair(
    vendorId: string,
    walletId: string,
  ): Promise<{ vendor: Vendor; wallet: VendorWallet }> {
    const vendor = await this.requireVendor(vendorId);
    const wallet = await this.deps.prisma.vendorWallet.findUnique({ where: { id: walletId } });
    // Checking ownership rather than just existence: a wallet id from another
    // vendor must read as not-found, not as someone else's row.
    if (!wallet || wallet.vendorId !== vendorId) {
      throw new NotFoundError(`Wallet '${walletId}' for vendor '${vendorId}'`);
    }
    return { vendor, wallet };
  }
}

function describeChallenge(vendor: Vendor, wallet: VendorWallet): string {
  return [
    "Sign this EIP-712 WalletControlProof to prove you hold the key for",
    `${wallet.address} on ${wallet.network}.`,
    `vendorId=${vendor.id} nonce=${wallet.controlProofNonce ?? ""}`,
  ].join(" ");
}

export function toWalletSummary(wallet: VendorWallet): WalletSummary {
  return {
    id: wallet.id,
    address: wallet.address,
    network: wallet.network as WalletSummary["network"],
    tokenContract: wallet.tokenContract,
    version: wallet.version,
    status: wallet.status,
    confirmedAt: wallet.confirmedAt?.toISOString() ?? null,
    supersededById: wallet.supersededById,
  };
}
