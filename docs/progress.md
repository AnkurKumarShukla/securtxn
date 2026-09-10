# Progress

**Rule: tick a box only after its unit test passes.** Structure/config tasks with
no testable behaviour are ticked when verified by hand — noted inline.
Parent stays unticked until every child is ticked.

`[ ]` todo · `[~]` in progress · `[x]` done + tested · `[-]` blocked (reason inline)
`→ Dnn` = decision record in [decisions.md](./decisions.md)

**PRIORITY CHANGE (D39): the Hedera ATS track is the primary deliverable.**
B1 is now critical path, ahead of A9/A10/A11. Track A is the credibility behind
the submission, not the submission itself. Every B1 qualification bar must be
met; partial credit is worth nothing there.

Track A remains stub-backed and tested; the remaining A sections are sized to
protect B1, not to compete with it. → D20, D39

---

## Phase 0 — Repo, scaffolding, access requests

### 0.1 Scaffolding

- [x] Monorepo skeleton — 3 apps, 3 packages → D12, D13, D14, D15
- [x] Root config — pnpm workspace, `tsconfig.base.json` (strict), `.npmrc` → D16
- [x] `.env.example` from §9 + vars the structure implies
- [x] Docs — `architecture.md` relocated, `progress.md`, `decisions.md`, `evidence-schema.md` skeleton
- [x] `fixtures/digilocker-synthetic/` directory + generation spec → D11
- [ ] `git init`; confirm `git status` hides `.env`, `*_key.csv`, `fixtures/digilocker/`, `digilocker_extract.txt`
- [x] Fix `.env` — secret now sourced from the CSV `API Secret` column; vars renamed to §9 spelling; dev pepper/JWT secrets generated (old file kept as `.env.bak`)
- [ ] Confirm the corrected live credential with one `POST /authenticate` call — **not billable** (`index.json`)
- [x] Local Postgres — docker `postgres-Sd7L`, host port 49155; `DATABASE_URL` set (db created on first `migrate dev`)
- [ ] Harden the container before real data: pin `postgres:16`, named volume, fixed port — currently `latest` + anonymous volume + ephemeral port
- [ ] `pnpm install`; verify guessed dependency ranges resolve (esp. `@hashgraph/asset-tokenization-sdk`)
- [ ] Generate synthetic fixture set (blocks CI) → D11

### 0.2 Fire access requests — do these first, they cost 20 min total → D20

- [x] Chainlink CRE — enrollment request via account team
- [x] World ID — email `developers@toolsforhumanity.com` for Selfie Check feature flag
- [-] Ledger — Speculos question moot: no hardware wallet in scope → D32

### 0.3 De-risk the interfaces before stubbing them → D20

- [ ] Hedera ATS — read installed SDK surface; §4.5 signatures are **unverified**, highest interface risk
- [ ] World ID — confirm nothing depends on the undocumented server-side response shape; keep `selfieCheckProofRef` opaque
- [ ] CRE — interface already matches verified API (`cre.handlerInTee`); no action
- [ ] DigiLocker — verified end-to-end; no action

---

## Track A — Core application (stub-backed)

### A0 · Server bootstrap

- [x] `config/index.ts` — Zod env validation; process refuses to start on invalid config → D22
- [x] Credential-format assertions — `secret_live_` prefix, distinct role secrets → D22
- [x] Structured logging with PII redaction at the serializer level (§5)
- [x] Error handler — one place errors become responses; 5xx internals never echoed → D21
- [x] Error vocabulary incl. `NotImplementedError` → 501 for unbuilt routes → D21
- [x] Helmet, CORS allowlist (never `*`), rate limiting keyed per-token then per-IP
- [x] Swagger UI at `/swagger`, OpenAPI generated from the route Zod schemas → D23
- [x] Auth plugin — `agent` / `approver` / `bridge`, each against its own secret → D12
- [x] `/health` (liveness) + `/health/ready` (database reachability)
- [x] Graceful shutdown on SIGINT/SIGTERM with a forced-exit timeout
- [x] `POST /dev/token` — absent in production, not flag-disabled → D24
- [x] 13 tests pass: config rejection cases, health, error shapes, role separation, OpenAPI
- [-] Swap in-memory rate-limit store for Redis — not applicable while single-process (limit becomes N × max across instances)

### A1 · Data model

- [x] Prisma enums — 7 from §3 + 3 promoted from String → D25
- [x] `Vendor` — individual + business + DigiLocker + attestation fields → D01, D02, D03
- [x] `VendorWallet` — versioning, explicit supersession relation, control proof, callback fields → D01, D25
- [x] `PaymentRequest` — amount at explicit `Decimal(38,18)` → D25
- [x] `ApprovalEvent`, `RecipientAcknowledgment`, `ExceptionCase`
- [x] `EvidenceRecord` — append-only, fork-proof by unique link → D07, D25
- [x] `prisma migrate dev` runs clean (`20260908183844_init_data_model`)
- [x] Seed: Vendor → CONFIRMED wallet → PaymentRequest, no FK errors; idempotent
- [x] Seed hardcodes `registryVerifiedContact` so callback control still executes → D05
- [x] Prisma CLI reads the repo-root `.env` via `dotenv-cli`; the app still uses its own loader
- [x] 18 data-model tests: enum parity, seeded chain, constraints, 18dp money round-trip
- [x] Blobs live in Postgres `bytea` via `EncryptedBlob`; the ref is a real FK → D30

### A2 · Shared types + config

- [x] `@cp/shared-types` — primitives, enums, vendor, identity, payment, approval, evidence, exception
- [x] `primitives.ts` — address / bytes32 / signature / amount written once, not per route → D26
- [x] `evidence.ts` — payload union per eventType, enforcing docs/evidence-schema.md → D27
- [x] `config/index.ts` — env parse, fail fast at boot → D22
- [x] `config/tiers.ts` — `TierThresholds` from `TIER_AMOUNT_LIMITS`, validated at boot → D08, D22
- [x] 20 contract tests: money precision, address format, payee discrimination, PII projection, evidence union, tier limits

### A3 · Identity — DigiLocker (real, fixture-backed)

> Not deferrable. Ungated, verified working, and `verificationTier` gates the decision engine.

- [x] `IdentityProvider` interface — `StructuredAddress` sourced from shared-types, no duplicate → D09
- [x] `parse/` — Aadhaar, PAN, profile; one XML parser for data **and** signature → D28
- [x] `normalise/date.ts` — day-first, unix-ms, and naive datetimes pinned to IST → D10, D29
- [x] `normalise/gender.ts` — `male` / `M` / `MALE` → one enum → D10
- [x] `normalise/name.ts` — exact after casefolding, deliberately not fuzzy → D10
- [x] Check 1 — XMLDSig verified against the embedded cert; integrity and trust kept separate → D04, D28
- [x] Check 2 — cross-document consistency, post-normalisation, field names only in failures → D04, D06
- [x] Check 3 — same-subject linkage, PAN `Person uid` == Aadhaar `KycRes txn` id → D02
- [x] Check 4 — TTL captured; expired documents fail rather than confirm → D06
- [x] `MockIdentityProvider` — fixture replay; session stays `created` until consent → D17
- [x] `DigiLockerProvider` — live client; token cached, timeouts, envelope unwrap → D31
- [x] `identity/routes.ts` + `service.ts` — 422 on any check failure, nothing persisted → D04
- [x] Consent stub served by the API, so the flow is complete without a frontend → D17
- [x] `container.ts` DI root — provider chosen in one place → D09
- [x] `GenericKycProvider` returns 501 rather than falling through silently → D21
- [x] Duplicate-identity guard: one DigiLocker account backs one vendor → D03
- [x] Config paths resolve against `repoRoot`, not cwd → D31
- [x] Both providers satisfy the interface and share `runIdentityChecks` → D09
- [x] Replay reproduces every value in `index.json` → `expected_check_results`
- [x] **Rejection paths by injection** — tampered byte, wrong issuer, unpinned cert, split accounts, expired TTL → D21
- [ ] **One** live consent run confirms `xmlSignatureVerified` + `crossDocConsistent`

#### A3 extras delivered

- [x] `lib/crypto.ts` — AES-256-GCM at rest + HMAC with pepper → D30
- [x] Encrypted DOB, address and portrait; PAN stored only as a digest → D06
- [x] 13 flow tests + 32 unit tests, driven through the real HTTP surface
- [ ] **One** live consent run — needs a human at DigiLocker; auth header shape unconfirmed → D31
      **CONFIRMED 2026-09-10: the demo runs this live, with a real user.** Not a fixture
      replay and not the mock provider, so this path has to be exercised well before
      demo day — it cannot be validated unattended.

## A4 · Identity → wallet binding

- [x] `POST /vendors` — server-generated `onboardingSessionNonce`, never client-supplied → D03
- [x] `PATCH /vendors/:id/kyb-status`, `GET /vendors/:id` (whitelist projection) → D27
- [x] `POST /vendors/:id/wallets` — versioned, carries the vendor's nonce not a fresh one → D01, D03
- [x] Nonce carried into the identity session and persisted on the vendor → D03
- [x] EIP-712 `WalletControlProof` — key custody only; does not advance status → D33
- [x] EIP-712 `IdentityBinding` — nonce + userId + wallet + both doc hashes → D03, D33
- [x] Nonce equality asserted between wallet and identity; mismatch rejects → D03
- [x] `aadhaarDocHash` / `panDocHash` persisted so the attestation stays verifiable → D33
- [x] `callback-confirm` rejects when `channelUsed` is not an independent contact → D05, D34
- [x] Independent contact for individuals = DigiLocker-verified mobile → D34
- [x] CONFIRMED requires all three gates: control proof + binding + callback → D34
- [x] 16 tests incl. the attacker's-own-key and attacker's-own-number attacks → D21
- [x] Test files run serially — shared Postgres, unique-constraint assertions

### A5 · Decision engine

- [x] `decide()` pure, no I/O imports; hard blocks before soft, first match wins → D08, D35
- [x] `FallbackVendorMatcher` — address checked exactly first, then fuzzy name score → D09, D35
- [x] `scoring/nameScore.ts` — Dice over tokens, corporate suffixes stripped; shared by both matchers → D35
- [x] `VENDOR_MATCH_MIN_SCORE` in config, not a literal → D08
- [x] `StubSanctionsScreener` behind the interface; `checkRef` says it performed no screening → D09, D21
- [x] Branch tests by direct input injection — all six branches plus precedence → D21
- [x] Wired through `container.ts`; `VENDOR_MATCHER=cre` throws rather than falling back silently → D09, D21
- [x] `POST /payments`, `POST /payments/:id/run-decision`, `GET /payments/:id`
- [x] Only SAFE_TO_SEND / SEND_TEST_AMOUNT reach AWAITING_APPROVAL; blocked verdicts stay pending
- [x] Re-running a decision after the payment moved on returns 409
- [x] 25 engine tests + 6 end-to-end payment tests

### A6 · Evidence chain (chain only — anchoring is B2)

> Must be correct before anchoring exists. A root published over a broken chain cannot be retroactively fixed. → D20

- [x] `canonicalize()` — sorted keys, array order kept, rejects non-round-trippable values → D07, D36
- [x] `computeRecordHash()` — keccak256 over payload + predecessor, bare 64-hex → D36
- [x] `verifyChain()` reports the FIRST break and distinguishes content from linkage → D36
- [x] `payload` column added: a chain of hashes alone cannot be recomputed or read → D36
- [x] Decision + vendor_match records written in the same transaction as the status change → D07
- [x] `GET /payments/:id/evidence` verifies on read; corrupting a real row → `false` at the right index
- [x] Evidence reads self-audit, appended after the response is built → D18
- [x] `docs/evidence-schema.md` filled per eventType
- [x] 19 chain tests + 5 integration tests incl. rollback and a PII-leak assertion
- [ ] Vendor-level events (identity verified, wallet confirmed) have no chain — `EvidenceRecord` requires a payment → D36

### A7 · Approval boundary (process split — core, not partner work)

> The *device* is deferrable; the boundary is not. Retrofitting a separate signing
> process and role-scoped auth later is a rewrite of the auth layer and every
> payment route. → D12, D20

- [x] Agent token rejected on every `/approvals/*` route — 401 at the crypto layer, not 403 → D12
- [x] Approver token rejected on `propose`; the role that approves cannot queue for itself → D12
- [x] `requireAnyRole` — approver AND bridge read the queue, each against its own secret → D37
- [x] `Proposal` model: "the engine permits this" is separate from "an agent queued it" → D37
- [x] `POST /payments/:id/propose` (agent only); refuses anything not AWAITING_APPROVAL → D37
- [x] `GET /approvals/pending`, `POST /approvals/:id/report-sent`
- [x] Double-send refused (409); consumed proposals leave the queue → D37
- [x] `approval-bridge` — separate app, HTTP only, imports nothing from the API → D12
- [x] CLI — list / approve / watch; `watch` deliberately never approves → D37
- [x] Transport abstraction `mock` | `local` | `usb` | `speculos`; last two fail loudly → D13, D32
- [x] `mock` transport — device-style prompt, synthetic hash, `broadcast: false` always reported → D32
- [x] `local` transport — keystore v3 decryption with MAC check; ERC-20 broadcast still to wire → D32
- [x] Operator types the amount back rather than pressing y → D37
- [x] End-to-end through the real CLI: propose → confirm → `SENT` + tx hash + 4-record chain valid
- [x] 7 API boundary tests + 9 bridge transport tests

### A8 · Internal identity-registry hook (core, not partner work)

> Inbound: ATS calls this, not the reverse. No partner dependency. → D20

- [x] `GET /internal/identity-registry/:address` → `{ verified, vendorId }` from `VendorWallet.status`
- [x] Fails closed: unknown, pending and revoked all answer `verified: false` → D38
- [x] Case-insensitive address matching — a checksummed address is the same address → D38
- [x] `GET /internal/vendor-lookup/:vendorId` → `{ legalName, wallets }` for the vendor match. Same inbound direction, same fail-closed rule (CONFIRMED wallets only), same narrow projection — name and addresses, never documents or PII → D44
- [x] Most recent CONFIRMED version wins, so re-confirmation after revocation works → D38
- [x] Optional `?network=` filter; the same address can exist on more than one chain
- [x] Authenticated — an open endpoint would enumerate business relationships → D38
- [ ] Dedicated `registry` role with its own secret, before exposing this to a third party → D38
- [x] 9 tests

### A9 · Web UI

**UN-SHRUNK.** D39 cut this to two screens to buy time for B1. That was
overridden: a productionised UI is non-negotiable, and the demo is filmed
through it rather than through Swagger. B1 shipped anyway.

- [x] **Landing page** — product named **SecurTxn**; hero, problem, solution, how it works, footer → D53
- [x] Tailwind v4 set up (CSS-only theme, no config file); one accent colour, colour reserved for meaning → D53
- [x] React Bits vendored, not depended on: Prism (hero), CardNav (nav), LetterGlitch (security panel), ShinyText, CountUp, SpotlightCard → D53
- [x] Hero cut to one heading and two lines; prism at its own defaults so the colour reads at full strength → D53
- [x] Hero heading is plain white — no gradient over an already-colourful background → D53
- [x] Nav is frosted glass over the prism: backdrop blur, saturation hold, lit top edge → D53
- [x] Every upstream change marked ADAPTED in the file that carries it → D53
- [x] Reduced motion honoured in CSS and in JS, so the page goes still rather than fast → D53
- [x] Prism suspends its WebGL loop once scrolled past → D53
- [x] Builds clean, prerenders static, 174 kB first load; one h1, four h2s
- [ ] Approval screen — the one moment genuinely better seen than described
- [ ] Evidence viewer — chain, verification result, break index
- [ ] Copy says "a live human confirmed this action", not "identity verified"
- [ ] **Launch App points at /payments, which is still a stub returning null** — the
      landing page is finished, the app behind it is not
- [-] Vendor onboarding form, AP dashboard, exception desk — Swagger is sufficient → D39

### A10 · Recipient ack + exception playbooks

- [x] `POST /payments/:id/acknowledgment` — EIP-712 verified server-side; the signer
      must be the address the money went to → D47
- [x] Raw acknowledged context encrypted into an `ACK_CONTEXT` blob; only the
      commitment reaches evidence → D47
- [x] Duplicate detection is a hard block **inside `decide()`**, ranked below sanctions → D47
- [x] A blocked duplicate auto-opens an `ExceptionCase` in the same transaction → D07, D47
- [x] Playbooks per `ExceptionType` — ordered, concrete operator actions → D47
- [x] `POST/GET/PATCH /exceptions` with step tracking; a closed case is immutable → D47
- [x] 11 tests, incl. the duplicate blocked before the approval queue

### A11 · Cross-cutting security (§5)

- [x] HMAC pepper from env, never literal — `lib/crypto.ts`, tested
- [x] AES-256-GCM at rest — DOB, address, portrait, and the acknowledged context blob; 5 crypto tests incl. tamper and wrong-key rejection
- [x] TLS 1.3 — three modes (`off` / `terminated` / `direct`), production refuses `off` → D55
- [x] `direct` verified: TLS 1.3 negotiated, plaintext refused, CA trust works without `-k`
- [x] `terminated` returns 426 for `x-forwarded-proto: http`; health probes exempt → D55
- [x] `trustProxy` only when a proxy is actually in front, never inferred → D55
- [x] Bridge refuses a plaintext API URL and trusts a private CA by ADDING it → D55
- [x] `cert:dev` script for local HTTPS, so the same certificate check runs locally
- [x] RBAC on evidence reads, and the read is itself audited → D18
- [x] No secrets committed — verified: `.env`, key CSVs, real fixtures all untracked
- [x] **RLS enabled on every public table** → D46, re-asserted by migration after each new table. The database was wide open through Supabase's REST API: every table readable, and UPDATE/DELETE permitted, with only the *publishable* key — a key designed to ship in browsers
- [ ] Rotate the publishable key — it has been exposed in a working session and sits in `.env`
- [ ] Decide whether Supabase's REST layer is needed at all; if not, restricting the exposed schema removes the door rather than locking it
- [x] EIP-712 verified server-side — control proof, identity binding, and recipient ack

### A12 · Core-complete checkpoint

- [x] Full flow demoable end-to-end — driven through the real CLI and curl, not only tests
- [x] Every stub is a named implementation behind an interface → D21
      (`GenericKycProvider`, `StubSanctionsScreener`, `MockComplianceGateway`, `UnavailableTransport`)
- [x] No blank 200 routes exist; unimplemented paths raise `NotImplementedError` → 501 → D21
- [x] Failure branches exercised by injection throughout → D21
- [x] Tag the commit — the fallback demo if a partner integration regresses

---

### A13 · Consumer API surface — every user action has an endpoint → D51

Chain operations existed only as scripts. A UI cannot run a script, so each one
that a person or a scheduler triggers is now a route.

**Issuer-scoped — the treasury operator drives these**

- [x] `POST /securities` — deploys a bond through the ATS factory AND registers the platform as a trusted credential issuer, in one call → D51
- [x] ISIN generated with a valid ISO 6166 check digit when omitted; the factory rejects a bad one → D51
- [x] `GET /securities`, `GET /securities/:id`, `/events`, `/holdings` — holdings read from chain, confirmed wallets only
- [x] `POST /securities/:id/mint` — to a CONFIRMED vendor wallet, or to the treasury to fund a payout → D51
- [x] `POST /securities/:id/coupon` — refused when the execution date falls past maturity
- [x] `PATCH /securities/:id/maturity` — compared against CHAIN time, not the server clock → D49
- [x] `POST /securities/:id/redeem` — manual override; refused before maturity
- [x] New `issuer` role with its own JWT secret: it cannot approve a payout, an approver cannot mint → D12, D51

**Approver-scoped — the only routes that spend**

- [x] `POST /payments/:id/settle` — DIRECT transfers, HTLC generates a secret and opens an escrow → D51
- [x] Refused unless the payment is AWAITING_APPROVAL; an agent token cannot reach it
- [x] `ledgerConfirmed: false` recorded, because no device confirmed it → D32
- [x] `POST /payments/:id/settlement/refund/execute` — manual trigger, refused before the timelock

**Payee-scoped — proven by signature, not by API token**

- [x] `POST /payments/:id/settlement/secret` — EIP-712 `SecretRelease` from the payout address → D51
- [x] Lock id is in the signed payload, so a signature cannot be replayed against the next escrow → D51
- [x] Preimage stored AES-256-GCM encrypted, never in the settlement row and never in the evidence chain → D51

**Backend-scheduled**

- [x] `POST /settlement/sweep-refunds` — returns every expired escrow to its payer
- [x] `POST /securities/sweep-maturity` — redeems every matured holding
- [x] One failure never stops a sweep; every failure is reported, not swallowed

**Verified**

- [x] 37 new API tests against the mock chain gateway, which keeps real balances → D51
- [x] Live run through the real HTTP routes on Hedera testnet: issue, mint, coupon, escrow, secret release, claim → D51
      new bond `0x246840eabb0652e6e7b18536713600f979b4c1dc`, claim `0x22eb7d92…`, acknowledgment recorded as `HTLC_CLAIM`
- [x] `pnpm --filter @cp/api smoke:chain` — a script, not a suite: it spends real gas → D51
- [ ] Bridge broadcasts neither mode; its `local` transport still throws on the transfer it never implemented

**Deployment**

- [x] `CHAIN_GATEWAY` defaults to mock, so a checkout with real credentials cannot spend by accident → D21
- [x] `.env.example` documents `sslmode=require`, `HOST=0.0.0.0`, and naming the exact frontend origin in CORS
- [ ] Migrations still run by hand; a deploy needs `prisma migrate deploy` in its release step
- [ ] Keystore path in the bridge does not exist on Railway or Render; a deployed signer needs the key from env or a KMS

---

## Track B — Partner integrations

One partner per branch. Merge only when it works end-to-end. A half-integrated
partner on `main` turns a working demo into a broken one. → D20

### B1 · Hedera ATS — PRIMARY DELIVERABLE — *ungated* → D39, D40

**Qualification bars — all four are mandatory, all four are at zero:**

- [x] Use ATS to issue or manage a tokenised asset — bond `0.0.10444329` issued via the factory
- [x] **On-chain deployment now VERIFIED BY THE SUITE, not just by hand** → D56. `packages/contracts/test/onchain.test.ts` (10 tests) re-queries the public Hedera mirror node: contracts exist and are not deleted, the bond's `created_timestamp` still matches (a swapped contract is caught, not just a missing one), mint/transfer/approve are present, and the compliance revert is there. Read-only, no key needed — a judge can run it
- [x] Public ATS infrastructure filled into `.env` (RPC relay, mirror node, factory, resolver, bond id), so the only remaining gap is a funded account
- [ ] **A FUNDED Hedera account** — ours (`0x7b83c510…`) is not one, so the API still resolves `complianceGateway: "mock"` and `grant-kyc` cannot broadcast here. Ask Arunava for `ATS_ISSUER_ACCOUNT_ID` + key, or create a free one at portal.hedera.com
- [x] Deploy and demonstrate on Hedera **testnet** — issuance + KYC grant both landed
- [ ] Public GitHub repo; contracts verified on **HashScan** where applicable
- [ ] Demo video **≤5 min**: issuance + configuration + ≥1 lifecycle operation
      (script ready: `deploy:testnet` → `prepare:security` → `lifecycle`)

**Prerequisites**

- [x] SDK surface verified against the installed 1.17.0 — §4.5's code does not exist → D40
- [x] Hedera testnet ECDSA account `0.0.10443799`; key derives the portal EVM address, 1000 HBAR
- [x] ATS testnet addresses — resolver `0.0.9212226`, factory `0.0.9213391`, verified live via mirror node
- [x] Bond config id `0x..02`; empty version resolves the latest at submit time
- [ ] Second ECDSA account for HCS anchoring, so the API key stays low-privilege → D40
- [x] Network/connection wiring verified — SDK is browser-only, no headless signer → D42
- [x] Contracts package ships ABIs + Solidity, so headless KYC grants are viable → D42
- [ ] MetaMask (or HashPack) on Hedera testnet for the issuance screen → D42

**Issuance**

- [x] Issued headlessly via `deployBond` against the factory ABI — reproducible, in-repo → D45
- [x] `internalKycActivated: true` — verified on chain, the token enforces KYC itself
- [x] Contract visible on HashScan: https://hashscan.io/testnet/contract/0.0.10444329

**Compliance — the differentiator**

- [x] `addIssuer` — platform registered as trusted issuer; `prepare:security` script is idempotent → D45
- [x] `VerifiableCredential` model — credential body off-chain, chain holds a reference → D42
- [x] `lib/vc.ts` — EIP-712 issuance signed by the platform issuer key → D42
- [x] Issued automatically when a wallet reaches CONFIRMED; claims record all six gates → D40
- [x] `GET /vendors/:id/wallets/:walletId/credential` — safe to disclose in full
- [x] `expiresAt` from `aadhaarKycTtl`; `usable` computed on read, never cached → D06
- [x] 11 credential tests + 4 integration, incl. a PII-leak assertion on the claims
- [x] On-chain call is `grantKyc(account, vcId, validFrom, validTo, issuer)` — reference only, no PII → D42
- [x] `validTo` = `aadhaarKycTtl`; absent TTL becomes a far-future date, never 0 → D06, D46
- [x] `ComplianceGateway` interface + `AtsComplianceGateway` (viem, headless) + mock → D40, D44
- [x] KYC ABI pinned from `IKyc.json` 8.0.0, with a test asserting the signature → D44
- [x] Hedera id → EVM address via the mirror node, not long-zero derivation → D44
- [x] `POST /vendors/:id/wallets/:walletId/grant-kyc` — separate and retryable → D44
- [x] Guards: wallet must be CONFIRMED, credential usable, issuer matches, no double grant
- [x] Waits for the receipt; a reverted grant is an error, not a success → D44
- [x] 11 gateway tests + 4 grant-path guard tests
- [x] Grant verified end to end: granted payee reads 1, an ungranted address reads 0
- [ ] `revokeKyc` wired to wallet revocation (no revoke endpoint yet)
- [x] **Rejection demonstrated on chain**: transfer to a non-granted account reverts, then succeeds once KYC is granted → D46

**Lifecycle — "real lifecycle management over a token with a name on it"**

- [x] Mint → compliance-gated transfer → coupon → maturity → redemption, all on testnet → D46, D49
- [x] `setCoupon` — corporate action; `rateStatus` must be SET for a standard-rate bond → D49
- [x] `updateMaturityDate` + `redeemAtMaturityByPartition` — holding 300000 → 0, supply reduced → D49
- [x] Every lifecycle role granted at deploy, so no follow-up grants are needed → D49
- [x] Demo is idempotent: it revokes the counterparty's KYC first, so the rejection always happens → D49
- [x] `PaymentHtlc.sol` — `lock` / `claim` / `refund`, no partial claims, no multi-hop, no cross-chain → D41, D50
- [x] Compiled with solc 0.8.36, evm `paris`, optimizer 200; artifact committed as TypeScript, no build step → D50
- [x] Deployed to Hedera testnet at `0x8ad684cff71aa37c7aa5a53b3a443dcd3e82285e` → D41
- [x] Escrow granted KYC on the security — the compliance gate applies to contracts too → D50
- [x] Claim restricted to the payee, and closed once the timelock passes, so claim and refund never overlap → D50
- [x] Refund callable by anyone; funds only ever go to the recorded payer → D50
- [x] Demo step 6: locked 5000 → wrong secret rejected → payee claimed, preimage on chain → D50
- [x] Demo step 7: locked 2500 → early refund rejected → timelock passed → refunded, payee restored → D50
- [x] Settlement mode is per-payment `DIRECT | HTLC`, DIRECT by default → D41, D50
- [x] `POST /payments/:id/settlement/{lock,claim,refund}` + `GET .../settlement`; the API records, never broadcasts → D50
- [x] Lock id re-derived server-side from the reported parameters; a mismatch is rejected → D50
- [x] Claim preimage hashed against the stored hashlock before anything is written → D50
- [x] A claim writes the recipient acknowledgment itself — `method = HTLC_CLAIM`, no signature asked for → D41, D50
- [x] A refund opens a MISDIRECT exception case; the payment moves to EXCEPTION → D50
- [x] Approver sees the settlement mode on the proposal, and the transport is told which shape it signs → D50
- [x] 16 API settlement tests + 22 contract tests; full suites green (238 API, 33 contracts, 10 bridge)

### B2 · Hedera — HCS evidence anchoring — *ungated* → D19, D52

- [x] `POST /evidence/anchor` — Merkle root over every unanchored record → D19
- [x] Submitted to topic `0.0.10454706`; `hcsAnchorTxId` AND the batch relation backfilled onto every record → D52
- [x] `GET /evidence/records/:id/proof` — inclusion proof verifiable against the anchored root → D52
- [x] `POST /evidence/anchors/:id/verify` — anchoring counts as done only once a mirror node serves it back → D52
- [x] `GET /evidence/anchors` — published anchors, newest first

**The Merkle layer** (`@cp/contracts`, 24 tests)

- [x] Domain separation: leaves prefixed `0x00`, nodes `0x01`, so a node cannot pose as a leaf → D52
- [x] Odd nodes promoted, never duplicated — duplication lets two leaf sets collide on one root → D52
- [x] Proof steps carry a side; pairs are never sorted, because position is what the proof claims → D52
- [x] Proof size stays logarithmic: 1000 records prove inclusion in 10 hashes

**Verified**

- [x] 14 API tests through HTTP against the mock consensus gateway
- [x] A tampered record stops matching its anchored root, and the service refuses to ship the bad proof
- [x] `pnpm --filter @cp/api smoke:anchor` — live run: root published, mirror node served it back, root recomputed by hand from the published algorithm and matched → D52
- [x] Live topic: https://hashscan.io/testnet/topic/0.0.10454706

**Fixed on the way**

- [x] Empty env values now treated as unset — a deployment platform injects `KEY=` and an optional var with a format rule took the whole boot down → D52
- [x] Consensus client closed on shutdown; without it the process never exits and a graceful stop hangs until SIGKILL → D52

### B3 · Ledger — real device — *DEFERRED: no hardware wallet in scope (D32)*

- [-] Swap transport for `usb` (or `speculos`) — env change only, no code change; only if a device appears → D13, D32
- [ ] Clear Signing prompt shows correct recipient + amount on device
- [ ] Real send produces a real `txHash`; `PaymentRequest` → `SENT`

### B4 · World ID — Selfie Check — **UNBLOCKED: access confirmed by running it** → D49

- [x] **Selfie Check access CONFIRMED** — not readable from the Portal API (no feature-flag field exists); proven by requesting the credential and getting `identifier: "selfie"`, `success: true`, `"Proof verified successfully"` back
- [x] Portal resources: app `app_e44f3e7a022dc3b7e807acaa0efaceaa`, RP `rp_a76c7d95ea331d5a` (registered prod + staging), action `verify-payment-approver` (both environments)
- [x] RP signing key rotated (the previous one was unrecoverable — the portal only ever returns the address) and stored server-only in `.env`
- [x] IDKit upgraded **2.4.2 → 4.2.3** — v2 has no `selfieCheckLegacy` and no `IDKitRequestWidget`; every API verified against the installed `.d.ts`, not docs prose
- [x] **Standalone test surface live** — `apps/web/src/app/world-id-test`, `environment: "sandbox"`, `preset: selfieCheckLegacy()`, `allow_legacy_proofs: true`. Prints the active preset/environment on screen so a reviewer can confirm the request without reading source
- [x] Server-side signing (`/api/world-id/rp-signature`) and verification (`/api/world-id/verify`, forwards the payload **as-is**). Confirmed by grepping the served HTML that the signing key never reaches the client bundle
- [x] Full round trip verified end to end: sandbox World ID app → camera selfie → proof → server verification success
- [x] **Continuity proven by a second live run** — same person, same action, fresh nonce/proof/merkle_root, **identical nullifier**. This is what makes "same human as at onboarding" possible without us holding a photo (D49a)
- [x] **Module built and tested — `apps/api/src/modules/worldid/` (21 tests)**
  - [x] `WorldIdVerification` table; nullifier as `Decimal(78,0)`, `UNIQUE (nullifier, action, signal)` — deliberately **not** the documented `UNIQUE (nullifier, action)`, which would let each human approve exactly one payment ever (D49)
  - [x] Nullifier normalised hex → decimal. Field elements come back **unpadded** — an observed `merkle_root` was 63 chars in one run and 64 in the next — so stored as text one person would be two (D49a)
  - [x] **Signal binding enforced** — the v4 verifier is never told which signal we expected, so `signal_hash` is compared against `hashSignal(expected)` before storing. Without it a valid proof bound to anything would authorise this payment (D49b)
  - [x] Replay rejected by our unique index, proven against the **real second capture** that World itself approved with `success: true` + "(nullifier reuse)"
  - [x] Continuity: enrollment recorded, later proofs compared; a different human rejected, a missing enrollment **fails closed**
  - [x] Our clock stored, not upstream `created_at` (which is first-seen, not verified-at — D49a)
  - [x] RLS enabled on the new table via migration, re-verified with the browser-shipped key
- [x] Both live captures saved as replayable fixtures + oracle — `fixtures/worldid/` (committed: nullifiers are one-way and RP-scoped, no identity data)
- [ ] Wire into the approval screen; widget success required before the proposal is written
- [ ] `selfieCheckProofRef` stored opaque; proof never stored raw
- [ ] Decide where the gate sits (approver vs payee) and which tiers require it

### B5 · Chainlink CRE — *DEMOTED below B1; fallback already tells the story* → D39

Demoted, not abandoned — the work below already happened before D39's
reprioritization and stands regardless of sequencing:

- [x] `@chainlink/cre-sdk` (1.20.0) added and typechecked against for real — no API assumed from docs prose alone. Verified directly from the installed package's `.d.ts` files
- [x] TEE handler via `cre.handlerInTee` (not `ConfidentialHTTPClient` — confirmed its `sendRequest` has no `TeeRuntime` overload) — `packages/cre-workflows/src/cre/workflow.ts`
- [x] Same wallet-then-name logic and shared `nameSimilarity()` as `FallbackVendorMatcher`, so the two cannot silently disagree (D09)
- [x] Package split: `@cp/cre-workflows` (root, CRE-free) vs `@cp/cre-workflows/cre` (subpath). Real bug found and fixed: the CRE SDK's `dist/index.js` uses a directory import Node's ESM resolver rejects — barrelling it into the root export broke every consumer, including `apps/api`'s tests. Reconfirmed 183 `apps/api` tests green after the split
- [x] Root-caused the earlier "`cre init` hangs" report: not a hang. `--deployment-registry` is required in `--non-interactive` mode but the CLI doesn't validate it upfront the way it correctly does `--project-name`/`--workflow-name` — instead it silently renders a full-screen interactive picker. `--deployment-registry=private` fixes it outright
- [x] Real reference implementation obtained (`cre init --template=hello-confidential-workflows-ts`) and diffed against our code. Found and fixed two real bugs: outbound requests need `multiHeaders`, not the deprecated `headers` map; SDK ships `ok()`/`json()` helpers we now use instead of hand-rolled parsing
- [x] `bun` installed — required to compile TS workflows to WASM, was silently missing
- [x] Workflow compiles to WASM and runs in the simulator under its declared "AWS Nitro in us-west-2" TEE constraint. `project.yaml` + `secrets.yaml` + `src/cre/workflow.yaml` + config JSON in place
- [x] Found and fixed a non-obvious bug → D43: `z.string().url()` fails unconditionally inside CRE's WASM runtime, even for indisputably valid URLs. Root cause likely the SDK's Javy/QuickJS engine lacking a working native `URL` constructor. Fixed with plain `z.string()`
- [x] **`/internal/vendor-lookup/:vendorId` built** — it did not exist; the workflow was calling an invented path (→ D44). Agent-scoped, returns only `legalName` + CONFIRMED wallets, nothing else
- [x] **All five verdict branches driven through the enclave against a live local API** — not one path, the whole result space (→ D44):

  | Payload | Verdict |
  |---|---|
  | Correct wallet, suffix-differing name | `MATCHED`, score **1.0** |
  | Wrong wallet address | `WALLET_NOT_ON_FILE` |
  | Right wallet, wrong network | `WALLET_NOT_ON_FILE` |
  | Right wallet, unrelated name | `NAME_BELOW_THRESHOLD` |
  | Unknown vendor | `VENDOR_NOT_FOUND` |

  The `MATCHED` run is what proves the parts a 404 cannot: the Vault secret was
  fetched inside the enclave and used as the Bearer token (a bad secret 401s,
  it does not match), the enclave's outbound HTTP reached a real API, and
  `nameSimilarity` actually ran — "MERIDIAN COMPONENTS PRIVATE LIMITED" against
  "Meridian Components Pvt Ltd" scored 1.0 with corporate suffixes stripped.
- [x] `cre-adapter.test.ts` — 5 tests on `CreVendorMatcher`'s own behaviour: signs, sends the input, and **throws on 401/504 rather than returning a negative verdict** (→ D45)
- [x] Simulator treated as logic verification only, never as a security demonstration — its own banner says so
- [-] `CreVendorMatcher` against the shared contract suite — **cannot be closed honestly without a deployed trigger** (→ D45). Stubbing the HTTP layer would test the stub, not the enclave
- [x] **Deploy access granted** — `cre whoami` now reports `Deploy Access: Enabled`
- [x] **`authorizedKeys` resolved** — the deploy answered it, no guessing needed. First attempt registered but failed activation: *"HTTP trigger requires at least one authorized key to sign JSON-RPC requests… ECDSA EVM public keys"*. So an open trigger is **structurally impossible**, not just unwise. Shape `{ type: "KEY_TYPE_ECDSA_EVM", publicKey }`, keys in `config.*.json` (public, not secret), schema enforces `.min(1)`
- [x] Secret uploaded to **Vault DON** — `cre secrets create secrets.yaml --secrets-auth browser` (browser auth for the private registry; the on-chain default wants `CRE_ETH_PRIVATE_KEY`)
- [x] Lookup endpoint made publicly reachable via ngrok **static** domain — static matters because a deployed workflow bakes `vendorLookupUrl` in at deploy time, so a rotating URL silently breaks it. ngrok interstitial verified a non-issue for non-browser agents; the skip header is sent anyway
- [x] All five branches re-verified **through the public tunnel** before deploying — same verdicts as local
- [x] ~~**DEPLOYED AND ACTIVE** — workflow ID `0091821287…`. Running on real Nitro enclaves, not the simulator~~ — **this claim was wrong and is retracted.** The deployment was ACTIVE and the gateway returned `ACCEPTED`, but *every* execution had already failed in 0ms without entering the handler: `confidential-workflows capability is disabled by settings … not allowed`. Nothing ran on an enclave. See D47
- [x] **Root-caused**: `confidential-workflows` is an entitlement granted **per workflow**, separate from deploy access and not reported by `cre whoami` (which says `Deploy Access: Enabled` and stays silent on this). Not a code defect
- [x] **Dual-mode handler** — one code path registers `cre.handlerInTee` or `cre.handler` based on a required `confidential` config field. Not a rename: the DON path takes a *function + `consensusIdenticalAggregation`* instead of a request object, because each node fetches independently and results must be reconciled
- [x] **Match rule extracted to `src/matching.ts`** as one pure `evaluateMatch()`, now shared by the fallback, the TEE handler and the DON handler. A third copy was one edit away; shared code cannot drift where a shared test only catches the cases it covers (strengthens D09)
- [x] **DEPLOYED, ACTIVE, AND VERIFIED EXECUTING** — workflow ID `00c06f9fc379b76606922ea574c412dbad4e77cfc25297c4d8d8d25a04db9ab2`, private registry, DON family `zone-a`, `confidential: false`. **All four invoked cases reached `SUCCESS`** (4–7s each), read back off finished executions, never off the `ACCEPTED` response
- [x] `scripts/invoke-workflow.mjs` — signs the JWT (`alg: ETH`, EIP-191 over the sorted-body SHA256 digest), invokes, then **polls each execution to a terminal state**. Reports nothing it did not read off a finished execution. Handles the gateway's `-32002` rate limit with backoff, and strips the `0x` the gateway returns but `cre execution status` rejects
- [x] **Corroborated independently via the ngrok request inspector**: the DON's outbound lookups are visible — several `200`s per execution (one per observing node) for the known vendor, `404`s for the unknown one, and `consensus@1.0.0-alpha` succeeded in every execution. Proves signed-JWT auth, gateway routing, DON scheduling, **Vault secret retrieval and use as the Bearer token**, and the real authenticated lookup
- [x] **`VENDOR_NOT_FOUND` proven on the deployed instance** — the unknown vendor logged `404`s and the execution still SUCCEEDED, so a 404 becomes a verdict rather than an error. Exactly the distinction D44 was written about
- [x] **Verdict return path built (D48/D48a)** — `workflows.execute` is fire-and-forget, so the workflow POSTs its verdict to `/internal/vendor-match-result` and `CreVendorMatcher` awaits the row. The row is created **before** invoking, which is what lets the endpoint reject a `requestId` it never issued; idempotent, because in DON mode every observing node posts the same verdict
- [x] **All four verdicts now proven on the deployed workflow** — `pnpm --filter @cp/api cre:e2e` drives the real container → real matcher → real gateway → real callback → real DB row against workflow `004efdb1f57cbe406505286d04e1721fbbd44423d875f0035dabd8e0770829c4`:

  | Case | Verdict from the deployed workflow |
  |---|---|
  | Correct wallet + name | `MATCHED`, match=true, score 1 |
  | Wrong wallet address | `WALLET_NOT_ON_FILE` |
  | Right wallet, unrelated name | `NAME_BELOW_THRESHOLD` |
  | Unknown vendor | `VENDOR_NOT_FOUND` |

  This is the check `SUCCESS` could not do: an always-`MATCHED` matcher would have looked identical across all four
- [x] **D45 closed** — the CRE implementation is exercised against the same four branches as the fallback, against a live deployment rather than a stub
- [x] **DI swap is real** — `VENDOR_MATCHER=cre` constructs `CreVendorMatcher`; missing `CRE_*` config fails at boot, not at the first payment (D21). Decision engine untouched
- [x] Callback endpoint tested (8 tests): rejects an unsolicited `requestId`, refuses an unauthenticated caller, idempotent across duplicate callbacks, a late conflicting verdict cannot overwrite, a failure records as `FAILED` with a null match — never as `match: false`
- [x] Adapter tested (9 tests): persists **before** invoking (asserted by call order, since a refactor could silently remove the check), polls rather than giving up on the first PENDING, distinct timeout/failure error types, refuses a `COMPLETED` row carrying no verdict
- [x] **RLS made reproducible** — D46 was applied by hand, so a fresh database came up without it and `VendorMatchRequest` would have been wide open. Now a migration looping over `pg_tables`, so a table added later cannot miss it. Re-verified with the publishable key
- [ ] TEE mode (`confidential: true`) — one config field, blocked only on the entitlement
- [ ] `VENDOR_MATCHER` left at `fallback` in `.env`: flipping it would drive 200+ tests through the live gateway and tunnel. One-word change, proven by `cre:e2e`

**Local run note**: `SECRET_VENDOR_LOOKUP_API_KEY` in `.env` is a real agent JWT
with ~12h expiry, since the workflow sends the Vault secret as the Bearer token
the lookup endpoint authenticates. Simulations 401 once it lapses — re-mint via
`POST /dev/token`.
