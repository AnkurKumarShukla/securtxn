# Confirmed Payee + Exception Desk — Technical Architecture

**Status**: Build spec for implementation. Written for an AI coding agent (Claude Code, Codex, etc.) or a human engineer to build directly from — every section states what to build, the exact interface, and the acceptance criteria for "done."

**One-line pitch**: a control layer that sits in front of stablecoin custodians (Fireblocks/Circle/bank/direct wallet) and prevents/limits the single most expensive failure mode in crypto B2B payments — sending money to the wrong wallet, irrecoverably — via pre-send beneficiary verification, human+hardware-gated approval, and a post-send exception/recovery desk.

---

## 0. Non-negotiable design principles

Every implementation decision below must satisfy these. If a PR/change violates one, it's wrong regardless of how convenient it is:

1. **The agent (autonomous code) never holds, sees, or can invoke a private key.** It writes proposals to a queue. Only a human-triggered process, gated by Ledger hardware confirmation, can move funds.
2. **No raw PII, location, device fingerprints, or vendor banking details are ever written on-chain, encrypted or not.** Only fixed-size commitment hashes (`keccak256` or `sha256`) go on-chain. Raw data lives off-chain, encrypted, in the evidence store.
3. **Every state-changing action produces an evidence record** appended to the hash chain (see §7.6) before the action is considered complete.
4. **Confidential vendor-matching logic (name/address/network checks against vendor PII) runs inside the Chainlink CRE TEE handler, not in the main API process**, whenever CRE access is available. A non-confidential fallback implementation must exist behind the same interface so the rest of the system doesn't care which is active (see §7.4).
5. **Signing commands and read-only commands are architecturally separate processes**, not just separate code paths in one process. See §7.3.

---

## 1. System architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            apps/web (Next.js)                        │
│   AP dashboard · Vendor onboarding · Exception desk UI · Evidence UI  │
└───────────────────────────────┬────────────────────────────────────┘
                                 │ HTTPS/REST
┌───────────────────────────────▼────────────────────────────────────┐
│                         apps/api (core platform)                     │
│  Vendor Registry · Decision Engine · Reconciliation · Exception Desk  │
│  Evidence Store (hash-chain)                                          │
└──────┬───────────────┬───────────────┬───────────────┬──────────────┘
       │               │               │               │
┌──────▼──────┐ ┌──────▼───────┐ ┌─────▼──────┐ ┌───────▼────────┐
│ packages/    │ │ apps/        │ │ packages/  │ │ Hedera network  │
│ cre-workflows│ │ approval-    │ │ contracts  │ │ (ATS + HCS)     │
│ (Chainlink   │ │ bridge       │ │ (ATS deploy│ │                 │
│ CRE vendor-  │ │ (LOCAL only, │ │ scripts)   │ │                 │
│ match TEE)   │ │ wraps        │ │            │ │                 │
│              │ │ wallet-cli)  │ │            │ │                 │
└──────────────┘ └──────┬───────┘ └────────────┘ └─────────────────┘
                         │ USB/HID
                  ┌──────▼───────┐
                  │ Ledger device │
                  │ (Clear Signing│
                  │  on-screen)   │
                  └───────────────┘
```

**Critical placement fact**: `apps/approval-bridge` runs **on the approver's local machine**, not in your cloud infrastructure — it is the only process with USB access to the Ledger. `apps/api` never talks to the Ledger directly; it only ever talks to `approval-bridge` over an authenticated channel (see §7.3 for exactly how).

---

## 2. Monorepo structure

```
/
├── README.md                        layout + boundary rationale
├── package.json                     (workspaces: apps/*, packages/*)
├── pnpm-workspace.yaml
├── tsconfig.base.json               strict options inherited by every package
├── .env.example                     template; see §9
├── apps/
│   ├── web/                         Next.js 15 (App Router), TypeScript
│   ├── api/                         Fastify + Prisma + PostgreSQL, TypeScript
│   │   ├── prisma/                  schema (§3) + seed
│   │   └── src/
│   │       ├── server.ts            Fastify assembly
│   │       ├── container.ts         DI root — the ONLY place an implementation is chosen
│   │       ├── config/              env parsing, tier thresholds
│   │       ├── plugins/             prisma, auth (role separation), errors, audit
│   │       ├── modules/             vertical slices: routes + service + schema together
│   │       │   ├── identity/        providers/ checks/ normalise/ parse/
│   │       │   ├── vendors/ wallets/ payments/ approvals/ exceptions/ evidence/
│   │       │   ├── decision/        pure state machine, no I/O
│   │       │   ├── sanctions/       interface + MVP stub
│   │       │   └── internal/        identity-registry hook consumed by ATS (§4.5)
│   │       ├── jobs/                HCS anchoring
│   │       └── lib/                 crypto, EIP-712, canonical JSON, Hedera, logging
│   └── approval-bridge/             Node CLI/daemon, wraps @ledgerhq/wallet-cli
├── packages/
│   ├── shared-types/                Zod schemas + TS types, imported by web/api/bridge
│   ├── cre-workflows/               VendorMatcher interface + fallback/ and cre/ impls
│   └── contracts/                   Hedera ATS deployment + config scripts
├── fixtures/
│   ├── digilocker/                  Recorded live responses — REAL PII, gitignored (§4.7.1)
│   │   ├── index.json                route map + expected assertions + format gotchas
│   │   ├── 0*.json                   one file per endpoint
│   │   ├── documents/*.xml           UNMODIFIED signed originals — never edit
│   │   └── README.md                 the only committed file
│   └── digilocker-synthetic/        Committed tier for CI — to be generated (§4.7.1)
└── docs/
    ├── architecture.md              (this file)
    ├── progress.md                  task checklist, ticked only after unit tests pass
    ├── decisions.md                 high-stakes decisions + reasoning
    └── evidence-schema.md           Canonical JSON schemas for hash-chain records
```

**Package manager**: pnpm (workspaces). **Language**: TypeScript everywhere — every external SDK involved here (Chainlink CRE TS templates, `@ledgerhq/wallet-cli`, `@hashgraph/asset-tokenization-sdk`, `@worldcoin/idkit`) is npm/TS-native, so there is no reason to introduce a second language anywhere in this stack.

---

## 3. Data models

Define these in `apps/api/prisma/schema.prisma`. This is the canonical schema — build every service against these shapes.

```prisma
enum WalletStatus {
  PENDING_VERIFICATION
  CONFIRMED
  REVOKED
}

enum PaymentDecision {
  SAFE_TO_SEND
  DO_NOT_SEND
  REVERIFY
  SEND_TEST_AMOUNT
}

enum PaymentStatus {
  DRAFT
  DECISION_PENDING
  AWAITING_APPROVAL
  APPROVED
  SENT
  CONFIRMED_ON_CHAIN
  EXCEPTION
}

enum ExceptionType {
  OVERPAY
  MISDIRECT
  DUPLICATE
  WRONG_ASSET
  DISPUTE
}

enum ExceptionStatus {
  OPEN
  IN_RECOVERY
  RESOLVED
  WRITTEN_OFF
}

enum PayeeType {
  INDIVIDUAL   // freelancer, contractor, sole supplier — NO business registry exists for these
  BUSINESS
}

enum VerificationTier {
  TIER0_UNVERIFIED  // wallet signature only — never eligible for SAFE_TO_SEND
  TIER1_LIVENESS    // + Selfie Check liveness + phone OTP
  TIER2_IDENTITY    // + government ID document with face match to liveness selfie
  TIER3_ADDRESS     // + physically verified address (postcard code preferred)
}

model Vendor {
  id                      String   @id @default(uuid())
  payeeType               PayeeType
  verificationTier        VerificationTier @default(TIER0_UNVERIFIED)

  // --- INDIVIDUAL payees ---
  legalFirstName          String?
  legalLastName           String?
  dobEncrypted            String?  // AES-256-GCM, KMS-wrapped — never plaintext
  idDocumentCheckRef      String?  // opaque ref to KYC provider session (Persona/Onfido/Sumsub)
  idDocumentType          String?  // PASSPORT_NFC | DRIVING_LICENSE | NATIONAL_ID | DIGILOCKER_AADHAAR
                                    // Government-signed sources (PASSPORT_NFC, DIGILOCKER_AADHAAR)
                                    // are materially stronger than a photo/OCR of a document
  faceMatchScore          Float?   // liveness selfie <-> ID document photo
  worldIdSelfieCheckRef   String?  // liveness/continuity credential

  // --- DIGILOCKER (India) — see §4.7. Verified working against live API 2026-09-08 ---
  digilockerUserId        String?  @unique
                                    // Stable pseudonymous DigiLocker account id, present in BOTH
                                    // the PAN <Person uid> and the Aadhaar KycRes txn string.
                                    // USE THIS as the identity primary key. Never the Aadhaar number.
  digilockerSessionId     String?
  aadhaarLast4            String?  // e.g. "1234". UIDAI returns "xxxxxxxx1234" — the full Aadhaar
                                    // number is NEVER exposed by DigiLocker. Do not build any UI
                                    // that asks a user to type it: receiving it would create
                                    // Aadhaar Data Vault obligations this flow otherwise avoids.
  aadhaarKycTtl           DateTime? // KycRes ttl (observed: issue + 1 year). Schedule re-verification
                                    // before this date; CONFIRMED is not permanent.
  panNumberHmac           String?  // HMAC-SHA256(PAN, pepper) — never plaintext
  panVerifiedOn           DateTime?
  photoEncryptedRef       String?  // encrypted ref to the UIDAI <Pht> portrait, used for face-match
  xmlSignatureVerified    Boolean  @default(false)
                                    // MUST be true before CONFIRMED. See §4.7 — an unverified XML
                                    // is just a text file; the XMLDSig signature IS the security property.
  xmlSignatureVerifiedAt  DateTime?
  crossDocConsistent      Boolean  @default(false)
                                    // name/dob/gender matched across Aadhaar and PAN. Mismatch is a
                                    // strong fraud signal and must block CONFIRMED.

  // --- BUSINESS payees ---
  legalEntityName         String?
  taxIdHmac               String?  // HMAC-SHA256(taxId, pepper) — never store raw
  registryVerifiedName    String?  // from business-registry lookup; mismatch vs submitted blocks KYB
  registryVerifiedContact String?  // contact AS RETURNED BY THE REGISTRY — see callback rule below

  // --- COMMON: verified reachability, used for dispute callout ---
  country                 String
  verifiedPhone           String?  // OTP-verified at onboarding, encrypted
  verifiedPhoneAt         DateTime?
  phoneLineType           String?  // MOBILE | LANDLINE | VOIP — VOIP/disposable MUST be flagged
                                    // weak: it is not usable for a real dispute callout
  verifiedEmail           String?
  verifiedAddressEncrypted Json?   // structured address, encrypted
  addressVerifiedMethod   String?  // POSTCARD_CODE | ID_DOCUMENT | DATABASE_LOOKUP | UNVERIFIED
  addressVerifiedAt       DateTime?

  // --- Signed attestation (dispute evidence) ---
  attestationSig          String?  // EIP-712 sig over attestationDataHash, signed by the payee's
                                    // wallet key: "I affirm this information about me is true."
                                    // Turns a data-entry claim into signed, repudiation-resistant
                                    // evidence usable in a legal dispute.
  attestationDataHash     String?
  attestedAt              DateTime?

  // --- Session binding (see "Identity binding" note below) ---
  onboardingSessionNonce  String?  // MUST be identical across the liveness check, the document
                                    // check, and the wallet control signature. Differing nonces
                                    // means the artifacts may belong to different people — reject.

  kybStatus               String   // PENDING | VERIFIED | REJECTED
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt
  wallets                 VendorWallet[]
  payments                PaymentRequest[]
}

model VendorWallet {
  id              String       @id @default(uuid())
  vendorId        String
  vendor          Vendor       @relation(fields: [vendorId], references: [id])
  address         String
  network         String       // e.g. "ethereum", "hedera"
  tokenContract   String?
  version         Int
  supersededById  String?      // points to the next version once rotated
  status          WalletStatus @default(PENDING_VERIFICATION)
  controlProofSig String?      // EIP-712 signature — proves WALLET CUSTODY ONLY.
                               // Does NOT prove the signer represents the named legal entity.
                               // Never treat this alone as sufficient for CONFIRMED.
  controlProofNonce String?
  callbackConfirmedAt   DateTime? // out-of-band confirmation timestamp
  callbackChannelUsed   String?   // the actual phone/contact dialed — MUST equal
                                   // Vendor.registryVerifiedContact for a new vendor, or the
                                   // pre-existing contact on file for an existing vendor's wallet
                                   // change. Reject confirmation if this doesn't match; never
                                   // accept a contact value taken from the current submission.
  callbackConfirmedBy   String?   // operator who placed the call
  confirmedAt     DateTime?
  createdAt       DateTime     @default(now())

  @@index([vendorId, version])
}

model PaymentRequest {
  id                       String          @id @default(uuid())
  vendorId                 String
  vendor                   Vendor          @relation(fields: [vendorId], references: [id])
  vendorWalletId           String
  invoiceRef               String
  amount                   Decimal
  token                    String
  network                  String
  senderContextCommitment  String          // keccak256 hash, see §7.6
  decision                 PaymentDecision?
  decisionReasonCode       String?
  matchScore               Float?
  status                   PaymentStatus   @default(DRAFT)
  txHash                   String?
  createdAt                DateTime        @default(now())

  approvalEvent            ApprovalEvent?
  recipientAck             RecipientAcknowledgment?
  exceptionCase            ExceptionCase?
  evidenceRecords          EvidenceRecord[]
}

model ApprovalEvent {
  id                       String   @id @default(uuid())
  paymentRequestId         String   @unique
  paymentRequest           PaymentRequest @relation(fields: [paymentRequestId], references: [id])
  approverId               String
  selfieCheckVerified       Boolean  @default(false)
  selfieCheckProofRef       String?  // opaque reference to stored IDKit result, not the raw proof
  ledgerConfirmed           Boolean  @default(false)
  ledgerConfirmedAt         DateTime?
  approvedAt                DateTime @default(now())
}

model RecipientAcknowledgment {
  id                       String   @id @default(uuid())
  paymentRequestId         String   @unique
  paymentRequest           PaymentRequest @relation(fields: [paymentRequestId], references: [id])
  recipientAddress         String
  recipientSignature       String   // EIP-712 sig over recipientCommitment
  recipientCommitment      String   // keccak256 hash of raw context, see §7.6
  rawContextEncryptedRef   String?  // pointer to encrypted blob, KMS-wrapped
  verifiedAt               DateTime @default(now())
}

model ExceptionCase {
  id                       String          @id @default(uuid())
  paymentRequestId         String          @unique
  paymentRequest           PaymentRequest  @relation(fields: [paymentRequestId], references: [id])
  type                     ExceptionType
  status                   ExceptionStatus @default(OPEN)
  playbookSteps            Json            // ordered array of {step, status, note}
  createdAt                DateTime        @default(now())
  resolvedAt               DateTime?
}

model EvidenceRecord {
  id                       String   @id @default(uuid())
  paymentRequestId         String
  paymentRequest           PaymentRequest @relation(fields: [paymentRequestId], references: [id])
  eventType                String   // e.g. "vendor_match", "decision", "approval", "send", "ack", "exception_opened"
  payloadHash              String   // hash of this record's canonical JSON payload
  previousRecordHash       String   // hash of the prior record in the chain (genesis = "0"*64)
  hcsAnchorTxId            String?  // filled in by the batch anchoring job, see §7.6
  createdAt                DateTime @default(now())

  @@index([paymentRequestId, createdAt])
}
```

**Acceptance criteria for this section**: `pnpm --filter api prisma migrate dev` runs clean, and a seed script can create one Vendor → one VendorWallet (CONFIRMED) → one PaymentRequest without foreign key errors.

### Identity verification — what each check actually proves

A wallet-control signature (`controlProofSig`) proves **key custody only**. It proves nothing about who the signer is. Onboarding must establish five *separate* claims, each with its own mechanism:

| Claim | Mechanism | Field |
|---|---|---|
| Real, live human | World ID Selfie Check (liveness + continuity) | `worldIdSelfieCheckRef` |
| Legal identity is X | Government ID doc check. **India: DigiLocker Aadhaar (§4.7) — issuer-signed by UIDAI, strongest available.** Elsewhere: NFC/ePassport chip > photo OCR | `idDocumentCheckRef`, `idDocumentType` |
| The ID belongs to this person | Face match: liveness selfie ↔ document photo (India: UIDAI `<Pht>` portrait) | `faceMatchScore` |
| Phone is real + reachable | OTP; flag VOIP/disposable as weak — unusable for dispute callout | `verifiedPhone`, `phoneLineType` |
| Address is real | **India: DigiLocker Aadhaar `Poa` — government-attested postal address, instant.** Elsewhere: postcard-with-code > ID document address > database lookup > utility bill (forgeable) | `addressVerifiedMethod` |

**India shortcut**: a single DigiLocker consent flow satisfies *legal identity + address + photo + tax ID* at once. For Indian payees this reaches `TIER3_ADDRESS` in one step and the postcard-code path is unnecessary. See §4.7.

**Identity binding — the failure this prevents**: each check above can individually pass while belonging to *different people*. An attacker can obtain a genuine completed KYC session (borrowed, bought, or from a mule) and pair it with their *own* wallet signature performed separately — every check passes, the identity is real, the key custody is real, but they are not the same person. **The control**: `onboardingSessionNonce` must be identical across the liveness check, the document check, and the wallet-control signature. If the nonces differ, reject onboarding. This is what chains `legal identity → live face → wallet key` into a single subject instead of three independent facts.

**Business-payee spoofing — the separate control for `payeeType = BUSINESS`**: an attacker can submit a real company's name/tax ID with their own wallet and their own phone number, sign correctly (it's their wallet), and if the callback dials the number they just submitted, they confirm their own fraud. `registryVerifiedContact` is therefore populated only from an independent business-registry lookup (new vendor) or from a contact on file predating the change request (existing vendor) — never from the current submission — and `callback-confirm` must be rejected server-side if `channelUsed` doesn't match. Do not ship a version that skips this check even for a demo; hardcode a `registryVerifiedContact` in seed data so the real control logic still executes.

**Tier gates the decision engine**: `verificationTier` is an input to `decide()`. A high-value payment to a `TIER1_LIVENESS` payee must return `REVERIFY`, not `SAFE_TO_SEND`. Set thresholds in config, not hardcoded.

**Honest limit to carry into any pitch**: this verifies *identity*, not *intent*. A fully verified person can still be a willing mule or act under coercion, and addresses go stale. What this buys is real recourse — a verified legal name and physically confirmed address you can actually pursue — plus a signed attestation making false information a repudiation-resistant act by the payee, not a data-entry error on your side.

---

## 4. Component deep-dives

### 4.1 `apps/api` — core platform

> **The payment sequence in this section is superseded by `docs/payment-flow.md`.**
> Two gates were added after this document was written and are enforced in the
> service, not by convention: the payee must accept before their identity is
> checked (D63), and the sender must pass a World ID check for that specific
> payment before the payee is notified (D64). The identity comparison itself is
> now over HMAC digests rather than name similarity (D62), so there is no score
> and no threshold anywhere in the decision path.

**Stack**: Fastify, Prisma, PostgreSQL, Zod for request validation (schemas shared from `packages/shared-types`).

**Responsibilities**: vendor CRUD + wallet versioning, the decision engine state machine, evidence hash-chain writes, exception case management, and orchestration calls out to CRE / ATS / approval-bridge.

**REST API surface** (build in this order — each endpoint should be usable/testable before moving to the next):

```
POST   /vendors                              create vendor (starts PENDING); server generates
                                               and returns onboardingSessionNonce
PATCH  /vendors/:id/kyb-status                mark VERIFIED/REJECTED (manual for MVP)

--- identity (DigiLocker for India, generic provider elsewhere — see §4.7) ---
POST   /vendors/:id/identity/session          body: { mobile?, docTypes: ["aadhaar","pan"] }
                                               calls IdentityProvider.startSession, carrying the
                                               vendor's onboardingSessionNonce in redirect state
                                               -> { sessionId, authorizationUrl }
                                               (the HUMAN opens authorizationUrl and consents)
GET    /vendors/:id/identity/status           proxies IdentityProvider.getStatus
POST   /vendors/:id/identity/complete         fetches documents, then runs ALL FOUR mandatory
                                               checks from §4.7: XMLDSig verification,
                                               cross-document consistency, same-subject linkage,
                                               TTL capture. Populates digilockerUserId,
                                               aadhaarLast4, panNumberHmac, address, photo ref.
                                               REJECT (422) if signature or consistency fails —
                                               never persist an unverified identity as usable.

POST   /vendors/:id/wallets                   register a new wallet version
                                               → generates a nonce, returns { challengeMessage }
POST   /vendors/:id/wallets/:walletId/control-proof
                                               body: { signature } — verify EIP-712 sig recovers
                                               to the wallet address; on success set status
                                               PENDING_VERIFICATION → still needs callback
POST   /vendors/:id/wallets/:walletId/callback-confirm
                                               body: { confirmedBy, channelUsed, notes }
                                               SERVER MUST REJECT (400) unless channelUsed ===
                                               Vendor.registryVerifiedContact (new vendor) OR
                                               matches a contact already on file predating this
                                               wallet's creation (existing vendor changing wallets).
                                               This is the control that stops an attacker from
                                               self-submitting their own callback number — see
                                               "Vendor identity spoofing" note below the schema.
                                               Only on a valid independent-channel match:
                                               sets status = CONFIRMED, confirmedAt = now()

POST   /payments                              create a PaymentRequest (status=DRAFT)
POST   /payments/:id/run-decision             triggers vendor-match (CRE or fallback, §4.3) +
                                               sanctions screen (mocked for MVP, §6) + writes
                                               decision, matchScore, decisionReasonCode;
                                               status → DECISION_PENDING → AWAITING_APPROVAL
                                               (only if decision is SAFE_TO_SEND or
                                               SEND_TEST_AMOUNT; otherwise stays DECISION_PENDING
                                               and surfaces to a human for REVERIFY/DO_NOT_SEND)
GET    /payments/:id                          full state incl. decision, evidence summary

POST   /payments/:id/propose                  agent-role-only: writes a signed proposal
                                               record the approval-bridge can poll for.
                                               MUST verify caller has "agent" role, never
                                               "approver" role — see §4.2 auth model.
GET    /approvals/pending                     approval-bridge polls this (bridge auth token)
POST   /approvals/:id/report-sent             approval-bridge posts back after wallet-cli
                                               send succeeds: { txHash, ledgerConfirmedAt }
                                               → creates ApprovalEvent, status → SENT

POST   /payments/:id/acknowledgment           recipient-side signed ack, verify signature
                                               server-side before accepting

POST   /exceptions                            open an ExceptionCase against a PaymentRequest
PATCH  /exceptions/:id                        advance playbookSteps / change status

GET    /payments/:id/evidence                 returns full evidence chain + verifies it
                                               (recomputes hash chain, flags any break)
                                               — every call to this endpoint is itself logged
                                               as an access event (see §5, masking/RBAC)
```

**Decision engine state machine** (implement as an explicit function, not scattered if/else):

```typescript
type DecisionInput = {
  vendorWallet: VendorWallet;
  verificationTier: VerificationTier;
  matchResult: { match: boolean; score: number; reasonCode: string };
  sanctionsHit: boolean;
  isNewOrChangedAddress: boolean;
  amount: Decimal;
};

// Tier thresholds live in config, NOT hardcoded — different customers will set
// different risk appetites. Example shape: { TIER1_LIVENESS: 1000, TIER2_IDENTITY: 50000 }
function decide(input: DecisionInput, cfg: TierThresholds): PaymentDecision {
  if (input.sanctionsHit) return "DO_NOT_SEND";
  if (input.vendorWallet.status !== "CONFIRMED") return "DO_NOT_SEND";
  if (input.verificationTier === "TIER0_UNVERIFIED") return "DO_NOT_SEND";
  if (!input.matchResult.match) return "REVERIFY";
  // a payee verified only to liveness level cannot receive a large payment
  if (input.amount.gt(cfg.maxAmountForTier(input.verificationTier))) return "REVERIFY";
  if (input.isNewOrChangedAddress) return "SEND_TEST_AMOUNT";
  return "SAFE_TO_SEND";
}
```

**Acceptance criteria**: a full vendor onboarding → wallet confirmation → payment request → decision → (if SAFE_TO_SEND) proposal write, is testable end-to-end via REST calls (Postman/curl script) with zero UI.

### 4.2 Auth model (build this before anything else touches money)

Two distinct roles, enforced at the API layer, not just the UI:

- **`agent`** role: can call `POST /payments`, `POST /payments/:id/run-decision`, `POST /payments/:id/propose`. **Cannot** call any `/approvals/*` endpoint.
- **`approver`** role: can call `GET /approvals/pending`, `POST /approvals/:id/report-sent`. **Cannot** call `/payments/:id/propose`.

Use separate API keys/JWTs per role, checked via middleware. This is the literal implementation of design principle #1 — write a test that asserts an `agent`-scoped token gets a 403 on `/approvals/*`.

### 4.3 `apps/approval-bridge` — the only thing that touches the Ledger

**Runs on**: the approver's local machine, never in cloud infra. It is a small Node CLI/daemon.

**Setup** (exact, verified commands):
```bash
npx skills add ledgerhq/agent-skills
npm i -g @ledgerhq/wallet-cli
```

**Behavior**:
1. Polls `GET /approvals/pending` on an interval (or the approver runs `approval-bridge list` manually).
2. For each pending proposal, prints a human-readable summary (recipient, amount, vendor name, decision reason) to the terminal.
3. On operator confirmation (`approval-bridge approve <id>`), shells out to `wallet-cli send --to <address> --amount <amount> --network <network>`. **The actual confirm/reject happens on the physical Ledger screen via Clear Signing** — the CLI call blocks until the device responds.
4. On success, captures the resulting tx hash and calls `POST /approvals/:id/report-sent`.

```typescript
// apps/approval-bridge/src/approve.ts — skeleton
import { execa } from "execa";

async function approvePayment(proposal: PendingProposal) {
  console.log(`Recipient: ${proposal.vendorName} (${proposal.address})`);
  console.log(`Amount: ${proposal.amount} ${proposal.token} on ${proposal.network}`);
  console.log(`Decision: ${proposal.decision} — ${proposal.decisionReasonCode}`);
  // operator physically confirms via CLI prompt, THEN:
  const { stdout } = await execa("wallet-cli", [
    "send", "--to", proposal.address, "--amount", proposal.amount,
    "--network", proposal.network,
  ]);
  const txHash = parseTxHashFromOutput(stdout);
  await reportSent(proposal.id, txHash);
}
```

**If Speculos is confirmed usable** (pending the Telegram support answer flagged in §9): point the bridge's device transport at the running Speculos instance instead of physical USB for local dev/demo; keep the code path identical, only the transport target changes via an env var (`WALLET_CLI_TRANSPORT=speculos|usb`).

**Acceptance criteria**: with a real (or Speculos) Ledger connected, `approval-bridge approve <id>` results in an on-device Clear Signing prompt showing the correct recipient and amount, and a successful send updates the PaymentRequest to `SENT` with a real `txHash`.

### 4.4 `packages/cre-workflows` — confidential vendor match

**Setup**:
```bash
curl -sSL https://app.chain.link/cre/install.sh | bash
cre init --template=hello-confidential-workflows-ts
```

**Interface contract** (this is what `apps/api` calls — build the fallback first, swap in CRE once enrollment clears):

```typescript
// packages/cre-workflows/src/vendorMatch.ts
export type VendorMatchInput = {
  vendorId: string;
  claimedLegalName: string;
  walletAddress: string;
  network: string;
  tokenContract?: string;
};
export type VendorMatchResult = { match: boolean; score: number; reasonCode: string };

export interface VendorMatcher {
  match(input: VendorMatchInput): Promise<VendorMatchResult>;
}
```

**Non-confidential fallback** (`FallbackVendorMatcher`): implements the same interface, runs the name/address/network comparison directly in `apps/api` against the Vendor/VendorWallet tables. Build and wire this first — it's what makes the whole pipeline demoable without waiting on CRE enrollment.

**CRE-backed implementation**, once enrolled — exact verified API:

```typescript
// packages/cre-workflows/src/workflow.ts
cre.handlerInTee(trigger, async (runtime) => {
  const apiKey = await runtime.getSecret({ id: "VENDOR_REGISTRY_API_KEY" });
  const resp = await HTTPClient.sendRequest(runtime, {
    url: `${vendorRegistryUrl}/internal/vendor-lookup`,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  // compute match score here, inside the enclave — vendor PII never leaves
  const verdict = { match: resp.data.match, score: resp.data.score, reasonCode: resp.data.reasonCode };
  return await runtime.usingTheDons(); // ONLY the verdict crosses the boundary
}, {}); // {} = any registered TEE/region; only AWS Nitro us-west-2 is live as of this writing
```

Do **not** use `ConfidentialHTTPClient` here — confirmed in the docs it lacks the `TeeRuntime` overload required inside a TEE handler.

**Local testing**:
```bash
cre workflow simulate my-workflow --target staging-settings --non-interactive --trigger-index 0
```
The simulator explicitly is not a real enclave — treat its output as logic verification only, never cite it as a security demonstration.

**Acceptance criteria**: `VendorMatcher` interface has two implementations passing the same test suite; `apps/api`'s decision engine is wired against the interface, not a concrete class, so swapping fallback↔CRE is a one-line dependency-injection change.

### 4.5 `packages/contracts` — Hedera ATS integration

**SDK**: `@hashgraph/asset-tokenization-sdk` (npm).

**What gets tokenized**: once a `PaymentRequest`'s underlying invoice has cleared verification (vendor CONFIRMED, decision SAFE_TO_SEND or already SENT), tokenize the **receivable** as a bond-like instrument via the Factory contract:

```typescript
// packages/contracts/src/deployReceivable.ts — conceptual shape, verify exact SDK method
// signatures against the installed package version before wiring this up
const factory = new ATSFactory(networkConfig);
const bond = await factory.deployBond({
  name: `Receivable-${invoiceRef}`,
  symbol: `RCV-${shortId}`,
  maturityDate: dueDate,
  faceValue: amount,
  // Control List module config: point the identity registry at YOUR platform's
  // confirmed-vendor endpoint, so only wallets your system has already verified
  // can hold/receive this token
  complianceConfig: {
    identityRegistryUrl: `${apiBaseUrl}/internal/identity-registry`,
    mode: "ERC3643",
  },
});
```

**The identity-registry hook is the real integration point**: implement `GET /internal/identity-registry/:address` in `apps/api` returning `{ verified: boolean, vendorId: string | null }` by looking up `VendorWallet.status === CONFIRMED`. This makes your KYC data the actual compliance backend ATS's ERC-3643 mode calls out to — not a cosmetic add-on.

**Modules to configure on deploy**: Control List (against the identity-registry hook above), Pause (manual kill switch), Lock (for the maturity/vesting period). Access Control, Supply Cap, and Snapshots per ATS defaults — no special configuration needed for MVP.

**Acceptance criteria**: a testnet deployment via `deployBond` succeeds, is visible on HashScan (Hedera's explorer), and a transfer attempt to a non-confirmed wallet address is rejected by the Control List module.

### 4.6 World ID Selfie Check — approver second factor

**Where it's used**: at the moment a human approver confirms a `SAFE_TO_SEND`/`SEND_TEST_AMOUNT` decision in `apps/web`, before the proposal is even written for the approval-bridge to pick up. This proves "a real distinct human" independently of "this specific hardware key holder" (which Clear Signing proves).

```tsx
// apps/web — approval confirmation screen
import { IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";

const preset = selfieCheckLegacy({ signal: approverUserId });

<IDKitRequestWidget
  open={open}
  onOpenChange={setOpen}
  app_id={process.env.NEXT_PUBLIC_WORLD_APP_ID!}
  action="confirm-payment-approval"
  rp_context={{ paymentRequestId }}
  preset={preset}
  handleVerify={handleVerify}
  onSuccess={(result) => submitApproval(paymentRequestId, result)}
/>
```

**Server-side**: forward the full IDKit result to World's verification endpoint (exact response shape is not publicly documented as of this writing — confirm with World's team once your feature-flag request is approved, do not guess at field names and hardcode them).

**Constraints to respect in the UI copy**: this is medium-assurance only — do not present it to users as "identity verified," present it as "a live human confirmed this action." World ID 3.0 only; don't add `allow_legacy_proofs` speculatively since it wasn't in their Selfie Check examples.

**Acceptance criteria**: clicking "Approve" in the web UI opens the IDKit widget (QR on desktop, deep link on mobile browser), and a successful scan calls `handleVerify`/`onSuccess` before the proposal is written to `/payments/:id/propose`.

### 4.7 DigiLocker identity provider (India) — **VERIFIED WORKING against live API, 2026-09-08**

This is the concrete implementation of account KYC **and** the identity→wallet mapping for Indian payees. Unlike every other external dependency in this spec, this one has been end-to-end tested against the live API — the sequence below is known-good, not inferred from docs.

**Provider**: Sandbox (`api.sandbox.co.in`) as the DigiLocker aggregator.

#### Pluggable interface

Build behind an interface so non-India payees fall through to a generic provider — same pattern as `VendorMatcher` in §4.4:

```typescript
export type IdentityResult = {
  providerUserId: string;          // stable pseudonymous id -> Vendor.digilockerUserId
  legalName: string;
  dob: string;                     // ISO
  gender: string;
  address?: StructuredAddress;
  photoBase64?: string;
  taxId?: string;                  // PAN for India
  documentsVerified: string[];     // e.g. ["aadhaar","pan"]
  signatureVerified: boolean;      // XMLDSig chain validated — see below
  ttl?: Date;                      // re-verification deadline
};

export interface IdentityProvider {
  startSession(input: { mobile?: string; docTypes: string[] }):
    Promise<{ sessionId: string; authorizationUrl: string }>;
  getStatus(sessionId: string):
    Promise<{ status: "created"|"succeeded"|"failed"|"expired"; consented: string[] }>;
  fetchIdentity(sessionId: string): Promise<IdentityResult>;
}
```

Implementations: `DigiLockerProvider` (India), `GenericKycProvider` (Persona/Onfido/Sumsub elsewhere), `MockIdentityProvider` (tests/demo).

#### The API sequence (exactly as verified)

```
1. POST /authenticate
     headers: x-api-key, x-api-secret, x-api-version: 1.0.0
     -> data.access_token            (24h validity)

2. POST /kyc/digilocker/user/verify
     body: { "@entity":"in.co.sandbox.kyc.digilocker.user.verification.request",
             "mobile":"<10 digits>" }
     -> data.user_exists : boolean   [pre-check; avoids creating dead sessions]

3. POST /kyc/digilocker/sessions/init
     body: { "@entity":"in.co.sandbox.kyc.digilocker.session.request",
             "flow":"signin",
             "redirect_url":"<your callback>",
             "doc_types":["aadhaar","pan"],
             "options":{ "verification_method":["aadhaar"],
                         "pinless":true,
                         "verified_mobile":"<10 digits>" } }
     -> data.session_id, data.authorization_url

4. [HUMAN STEP] user opens authorization_url, signs into DigiLocker, consents.
     PKCE-protected (code_challenge_method=S256). Consent window ~1 hour.
     THIS CANNOT BE AUTOMATED — and that is the point: it is what makes
     DigiLocker legally defensible as an identity source.

5. GET /kyc/digilocker/sessions/{session_id}/status
     -> status: created|succeeded|failed|expired ; documents_consented[]

6. GET /kyc/digilocker/sessions/{session_id}/user/profile
   GET /kyc/digilocker/sessions/{session_id}/documents/{aadhaar|pan}
     -> data.files[0].url = S3 presigned URL to the issuer-signed XML
```

`verified_mobile` is **prefill only** — it is not a lookup key. There is no way to retrieve anyone's documents by phone number; consent is mandatory.

#### What the documents actually contain

| Source | Fields |
|---|---|
| Aadhaar (issuer: UIDAI) | `uid` **masked to last 4 only**; `Poi`: name, dob, gender; `Poa`: co, street, landmark, locality, vtc, po, subdist, dist, state, pincode, country; `LData`: same in local language; `Pht`: base64 JPEG portrait; `KycRes.ttl` ≈ +1 year |
| PAN (issuer: Income Tax Dept) | PAN number, status, name, dob, gender, `verifiedOn`, QR, `Person uid` |

#### Four mandatory server-side checks (do not skip any)

1. **Verify the XMLDSig signature.** Both documents are enveloped-signed, chaining to `CN=DS DIGITAL INDIA CORPORATION, O=DIGITAL INDIA CORPORATION` under a licensed Indian CA (observed: ProDigiSign Sub CA DSC 2022). **Parsing the XML without verifying the signature throws away the entire security property** — an unverified XML is just a text file. Set `xmlSignatureVerified` only after the chain validates against the CA root and the digest matches.
2. **Cross-document consistency.** Assert name (case-insensitive), dob, and gender match between Aadhaar and PAN. Set `crossDocConsistent`. A mismatch must block `CONFIRMED` — it is a strong fraud signal.
3. **Same-subject linkage.** The DigiLocker user id appears in *both* the PAN `Person uid` and inside the Aadhaar `KycRes txn` string. Assert they are equal, then persist as `digilockerUserId`. This is the identity primary key.
4. **TTL enforcement.** Store `KycRes.ttl` in `aadhaarKycTtl` and schedule re-verification before expiry. `CONFIRMED` is time-bounded, not permanent.

#### Identity → wallet mapping (the actual binding)

DigiLocker proves *who someone is*. The EIP-712 signature proves *what key they hold*. Neither alone maps identity to a wallet — the binding is what makes the mapping trustworthy:

1. Server generates `onboardingSessionNonce` and stores it against the pending Vendor record.
2. DigiLocker session is initiated **with that nonce carried in `redirect_url` state**, so the returned consent is tied to this specific onboarding attempt.
3. World ID Selfie Check liveness capture is taken in the same session, carrying the same nonce as its `signal`.
4. Face-match the liveness capture against the UIDAI `<Pht>` portrait → `faceMatchScore`.
5. The payee signs an **EIP-712 attestation whose payload includes the nonce, `digilockerUserId`, the wallet address, and hashes of both documents**:

```typescript
const attestation = {
  domain: { name: "ConfirmedPayee", version: "1", chainId },
  types: { IdentityBinding: [
    { name: "onboardingSessionNonce", type: "bytes32" },
    { name: "digilockerUserId",       type: "string"  },
    { name: "walletAddress",          type: "address" },
    { name: "aadhaarDocHash",         type: "bytes32" },
    { name: "panDocHash",             type: "bytes32" },
    { name: "statement",              type: "string"  }, // "I affirm this information is true and this wallet is mine."
  ]},
  message: { /* ... */ },
};
```

6. Server verifies the recovered signer equals the claimed wallet address, **and** that every artifact carries the same nonce. Any nonce mismatch means the artifacts may belong to different people — reject the onboarding.

Only when all of steps 1–6 pass does `VendorWallet.status` become `CONFIRMED`. Persist the signature in `attestationSig` and its payload hash in `attestationDataHash`.

**Why this matters for disputes**: the payee has now cryptographically signed a statement binding their government-verified legal identity and physical address to a specific wallet. If the details prove false, that is a signed false attestation by them — not a record-keeping failure by you. That is the difference between "we have a form they filled in" and evidence usable in recovery proceedings.

#### Tier mapping for Indian payees

A completed DigiLocker Aadhaar + PAN flow with all four checks passing, plus a bound wallet signature, yields `TIER3_ADDRESS` directly. The postcard-code path in the generic flow is unnecessary for India.

### 4.7.1 Offline development against recorded fixtures

**Live KYC calls are billed per request.** `user/verify`, `sessions/init`, `user/profile`, and both `documents/*` fetches are billable; `authenticate` and `status` are not. Do not develop against the live API — a real capture from 2026-09-08 is recorded in `fixtures/digilocker/` and should be replayed instead.

`MockIdentityProvider` reads `fixtures/digilocker/index.json`, matches on method + path, returns the recorded body, and serves `documents/*.xml` in place of the (short-lived, expiring) presigned S3 URL. Select it with `IDENTITY_PROVIDER=mock`.

**The consent step is the one thing mocking cannot faithfully reproduce.** In mock mode, `startSession` should return an `authorizationUrl` pointing at a local stub page that flips the session to `succeeded` on visit — this keeps the real state machine (`created → succeeded`) exercised rather than short-circuited. Never let mock mode skip straight to `succeeded`, or you will not catch bugs in the polling path.

**Two fixture tiers are required, because redaction is impossible here.** Editing a single byte of the signed XML invalidates the XMLDSig signature, so there is no redacted-but-still-valid variant:

| Tier | Contents | Committed | Purpose |
|---|---|---|---|
| Real | Genuine signed Aadhaar/PAN | ❌ gitignored | Signature-verification tests, one-time integration validation |
| Synthetic | Fake identities, unsigned/self-signed XML | ✅ committed | CI, UI work, everything else |

Build the synthetic set before any CI pipeline exists, or CI will have nothing to run against.

**`index.json` doubles as the test oracle.** Its `expected_check_results` block holds exactly what replaying the fixtures must yield — `xmlSignatureVerified`, `crossDocConsistent`, `digilockerUserId`, `aadhaarLast4`, `aadhaarKycTtl` and the resulting tier. The values are deliberately NOT reproduced here: they identify a real person, and `fixtures/digilocker/` is gitignored for that reason. Tests read them at runtime via `apps/api/test/fixtures/oracle.ts` rather than hardcoding them into committed source.

#### MANDATORY normalisation before the consistency check

The same person's details come back formatted **three different ways** across endpoints. A naive equality comparison fails on all three and rejects a legitimate user — this is the single most likely bug in this integration:

| Field | Profile endpoint | Aadhaar XML | PAN XML | Rule |
|---|---|---|---|---|
| Date of birth | `19/11/2001` | `19-11-2001` | `19-11-2001` | Parse to ISO date before comparing |
| Gender | `male` | `M` | `MALE` | Map to a single enum |
| Name | — | `Ankur Kumar Shukla` | `ANKUR KUMAR SHUKLA` | Case-insensitive, collapse whitespace |

Also note the profile endpoint's `date_of_birth` is documented as a unix-ms timestamp but returned a `DD/MM/YYYY` string in the live capture — **handle both types**.

#### PII handling constraints (statutory, not stylistic — applies to the whole DigiLocker flow)

- Never persist the full Aadhaar number — you never receive it. Store `aadhaarLast4` only.
- UIDAI rules prohibit sharing/publishing/displaying the XML or its contents. Encrypt at rest (`photoEncryptedRef`, address fields), gate reads behind RBAC, and log every access as an evidence event.
- Store PAN as `panNumberHmac`, never plaintext.
- Never write any of this on-chain, encrypted or otherwise — commitment hashes only, per design principle #2.
- The recorded fixtures are real PII too: `fixtures/digilocker/` is gitignored except its README, and must stay that way.

#### Acceptance criteria (§4.7 + §4.7.1 together)

`DigiLockerProvider` and `MockIdentityProvider` both satisfy `IdentityProvider` and pass the same test suite. Replaying the fixtures reproduces every value in `index.json` → `expected_check_results`. A completed live consent produces a Vendor with `xmlSignatureVerified = true`, `crossDocConsistent = true`, a populated `digilockerUserId`, and a `VendorWallet` whose `attestationSig` recovers to its own address under the same `onboardingSessionNonce`.

---

### 4.8 Evidence hash-chain + HCS anchoring

**Canonical payload format** for every `EvidenceRecord.eventType`, defined in `docs/evidence-schema.md` and enforced via Zod schemas in `packages/shared-types`:

```typescript
type EvidencePayload = {
  eventType: string;
  paymentRequestId: string;
  timestamp: string; // ISO 8601
  data: Record<string, unknown>; // event-specific fields, e.g. { decision, reasonCode }
};

function canonicalize(payload: EvidencePayload): string {
  // MUST use a deterministic stringify (sorted keys) — do not use JSON.stringify directly,
  // key order is not guaranteed across engines/versions
  return canonicalJsonStringify(payload);
}

function computeRecordHash(payload: EvidencePayload, previousRecordHash: string): string {
  return keccak256(canonicalize(payload) + previousRecordHash);
}
```

Every write path in `apps/api` that changes `PaymentRequest` state must, in the same transaction, insert an `EvidenceRecord` with `previousRecordHash` set to the prior record's `payloadHash` for that `paymentRequestId` (genesis record uses `"0".repeat(64)`).

**Batch anchoring job** (`apps/api/src/jobs/anchorEvidence.ts`, runs on a schedule, e.g. every 15 minutes):
1. Collect all `EvidenceRecord`s since the last anchor with `hcsAnchorTxId IS NULL`.
2. Build a Merkle tree over their `payloadHash` values.
3. Submit the Merkle root to a Hedera Consensus Service (HCS) topic.
4. Write the resulting HCS transaction ID back to every included record's `hcsAnchorTxId`.

**Acceptance criteria**: calling `GET /payments/:id/evidence` recomputes the hash chain from genesis and returns `chainValid: true`; manually corrupting one record's `payloadHash` in the DB makes a subsequent call return `chainValid: false` at the correct break point.

---

## 5. Security implementation checklist

Concrete, mapped to libraries — implement in this order, don't defer to "later":

- [ ] **Hashing**: `taxIdHmac` via `crypto.createHmac('sha256', PEPPER)`, pepper loaded from KMS/env, never hardcoded.
- [ ] **Encryption at rest**: PostgreSQL column-level encryption (or application-level AES-256-GCM before write) for `rawContextEncryptedRef` payloads and any raw KYB fields beyond `taxIdHmac`.
- [ ] **TLS 1.3** on every service-to-service call, including `approval-bridge → api` (self-signed cert acceptable for local dev, real cert for anything deployed).
- [ ] **RBAC + audit-logged reads**: every call to `/payments/:id/evidence` writes its own `EvidenceRecord` (`eventType: "evidence_accessed"`) — reading the audit trail is itself audited.
- [ ] **Secrets**: no secrets in code or `.env` committed to git. Use `.env.example` with placeholder values; real values injected via the deployment environment or a local `.env` in `.gitignore`.
- [ ] **Signature verification**: both `control-proof` (vendor wallet ownership) and `acknowledgment` (recipient signed ack) endpoints must verify the EIP-712 signature recovers to the claimed address server-side before accepting — never trust a client-asserted address.

---

## 6. What's mocked vs real (MVP scope)

| Component | MVP status | Real implementation later |
|---|---|---|
| **Identity / KYC (India)** | **REAL — DigiLocker via Sandbox, verified end-to-end against live API 2026-09-08 (§4.7). Develop against recorded fixtures (§4.7.1); live calls are billable.** | Same; add XMLDSig verification if not done in MVP |
| Identity / KYC (non-India) | `MockIdentityProvider` behind the same interface | Persona/Onfido/Sumsub |
| Vendor KYB (business payees) | Manual form + manual `PATCH kyb-status` approval | Persona/Alloy registry lookup |
| Sanctions screening | Stub always returns `sanctionsHit: false` | Chainalysis/TRM/OFAC feed |
| Vendor match (CRE) | `FallbackVendorMatcher` runs first; swap to CRE-backed once enrollment clears | CRE confidential workflow, live |
| World ID Selfie Check | Build the UI flow; wire to real IDKit once feature flag is approved | Same, once approved |
| Ledger signing | Real `wallet-cli` against physical device or Speculos (confirm which via Ledger's Telegram support) | Same |
| Hedera ATS | Real testnet deployment | Same, mainnet when ready |
| Recipient acknowledgment | Build the full signed-ack flow; only works for vendors who've onboarded (expected — see design note in prior conversation) | Same, wider adoption |

---

## 7. Build phases (in order — each has a clear "done")

**Phase 1 — Core platform + DigiLocker identity**
Build: Prisma schema, vendor/wallet endpoints, `IdentityProvider` interface with `DigiLockerProvider` + `MockIdentityProvider` (fixture-backed, §4.7.1), the format-normalisation layer, the four mandatory §4.7 checks, the nonce-bound EIP-712 identity→wallet attestation, `FallbackVendorMatcher`, decision engine, evidence hash-chain writes.
Done when: replaying the recorded fixtures reproduces every value in `index.json`'s `expected_check_results`; **and** a real DigiLocker consent produces a `CONFIRMED` VendorWallet with `xmlSignatureVerified` and `crossDocConsistent` true and a nonce-matched attestation signature; and a seed script can take a vendor from creation through a `SAFE_TO_SEND` decision with a verifiable evidence chain.
Build against fixtures first, then do **one** live run to confirm — not the other way around.
Note: DigiLocker is the one external integration with **no access gate** — credentials work today (see §8), so it belongs in Phase 1 rather than being deferred.

**Phase 2 — Ledger approval loop**
Build: `apps/approval-bridge`, `/payments/:id/propose`, `/approvals/*` endpoints, auth-role separation.
Done when: a proposal written by an `agent`-scoped call is picked up by the bridge, confirmed on a real or Speculos Ledger via Clear Signing, and results in `status: SENT` with a real `txHash`.

**Phase 3 — Web UI**
Build: `apps/web` — vendor onboarding form, AP dashboard, approval confirmation screen (with Selfie Check widget wired, even if pointed at a stub until the feature flag clears), exception desk, evidence viewer.
Done when: the full flow is operable by clicking through the UI with zero direct API calls needed.

**Phase 4 — Hedera ATS**
Build: `packages/contracts`, identity-registry hook endpoint, testnet deployment script.
Done when: a confirmed payment's receivable is tokenized on Hedera testnet, visible on HashScan, and a transfer to a non-confirmed wallet is rejected on-chain.

**Phase 5 — CRE swap-in + HCS anchoring**
Build: CRE-backed `VendorMatcher` (once enrolled), the batch anchoring job.
Done when: dependency injection swaps `FallbackVendorMatcher` for the CRE implementation with no changes to the decision engine; evidence chain is periodically anchored to an HCS topic and `hcsAnchorTxId` is populated.

**Phase 6 — Recipient acknowledgment + exception desk playbooks**
Build: `/payments/:id/acknowledgment`, exception case creation on reconciliation mismatch, playbook step tracking.
Done when: a simulated duplicate-payment attempt is auto-blocked before reaching the approval queue, and opens an `ExceptionCase` instead.

---

## 8. Known external access gates (confirm status before Phase 5/relevant Phase 3 work)

- **DigiLocker via Sandbox: ✅ NO GATE — WORKING.** Live credentials validated, full consent flow completed, both documents retrieved 2026-09-08. Build against it immediately.
- Chainlink CRE Confidential Workflows: private beta, requires enrollment through the Chainlink account team — status: **unconfirmed, follow up needed**.
- World ID Selfie Check: requires emailing developers@toolsforhumanity.com for feature-flag enablement — status: **unconfirmed, follow up needed**.
- Ledger hardware vs Speculos: not addressed on Ledger's ETHOnline page — status: **ask in Ledger's Telegram support group**.

**Sandbox test-environment warning**: `test-api.sandbox.co.in` is a mock replayer that only responds to request bodies exactly matching saved examples. No DigiLocker examples exist on this account, so every DigiLocker call 404s there — and test mode could never return real documents anyway. Use live credentials for any real identity flow; use `MockIdentityProvider` for automated tests.

Do not block Phase 1–3 work on any of these — the fallback/stub paths exist specifically so the core product is fully demoable regardless of how these resolve.

---

## 9. Environment variables (`.env.example`)

```
DATABASE_URL=postgresql://user:pass@localhost:5432/confirmed_payee
HMAC_PEPPER=                        # KMS-managed in production
JWT_AGENT_SECRET=
JWT_APPROVER_SECRET=
CRE_ENROLLMENT_ID=                  # blank until enrollment confirmed
WORLD_APP_ID=
WORLD_FEATURE_FLAG_ENABLED=false    # flip once World confirms access

# DigiLocker via Sandbox (§4.7) — WORKING. Values live in sbox_live_key.csv,
# columns "API Key" / "API Secret". Both files are gitignored.
SANDBOX_BASE_URL=https://api.sandbox.co.in
SANDBOX_LIVE_KEY=key_live_...
SANDBOX_LIVE_SECRET=secret_live_...   # MUST start with secret_live_, NOT key_live_
DIGILOCKER_REDIRECT_URL=              # your callback; carries onboardingSessionNonce in state
IDENTITY_PROVIDER=digilocker          # digilocker | generic | mock
HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=
HEDERA_OPERATOR_KEY=
WALLET_CLI_TRANSPORT=usb            # or "speculos"
```
