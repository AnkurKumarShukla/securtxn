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

**SHRUNK to two screens (D39).** Everything else demos through Swagger; a
half-built five-page dashboard costs B1 time and adds nothing to the pitch.

- [ ] Approval screen — the one moment genuinely better seen than described
- [ ] Evidence viewer — chain, verification result, break index
- [ ] Copy says "a live human confirmed this action", not "identity verified"
- [-] Vendor onboarding form, AP dashboard, exception desk — Swagger is sufficient → D39

### A10 · Recipient ack + exception playbooks

- [ ] `POST /payments/:id/acknowledgment` — server-side signature verify
- [ ] Exception opened on reconciliation mismatch
- [ ] Playbook step tracking per `ExceptionType`
- [ ] Duplicate-payment attempt blocked before the approval queue, opens `ExceptionCase`

### A11 · Cross-cutting security (§5)

- [ ] HMAC pepper from KMS/env, never literal
- [x] AES-256-GCM at rest for PII columns + evidence blobs — 5 crypto tests incl. tamper and wrong-key rejection
- [ ] TLS 1.3 service-to-service incl. bridge → api
- [x] RBAC on evidence reads, and the read is itself recorded → D18
- [ ] No secrets committed
- [x] **RLS enabled on all 11 public tables** → D46. The database was wide open through Supabase's REST API: every table readable, and UPDATE/DELETE permitted, with only the *publishable* key — a key designed to ship in browsers
- [ ] Rotate the publishable key — it has been exposed in a working session and sits in `.env`
- [ ] Decide whether Supabase's REST layer is needed at all; if not, restricting the exposed schema removes the door rather than locking it
- [ ] Both EIP-712 verifications server-side

### A12 · Core-complete checkpoint

- [ ] Full flow demoable end-to-end with every partner stubbed
- [ ] Every stub is a **named implementation behind an interface**, never a blank 200 route → D21
- [ ] Unimplemented routes return 501, not 200 → D21
- [ ] Failure branches all exercised by injection, not by waiting on a real integration → D21
- [ ] Tag this commit — it is the fallback demo if no partner integration lands

---

## Track B — Partner integrations

One partner per branch. Merge only when it works end-to-end. A half-integrated
partner on `main` turns a working demo into a broken one. → D20

### B1 · Hedera ATS — PRIMARY DELIVERABLE — *ungated* → D39, D40

**Qualification bars — all four are mandatory, all four are at zero:**

- [ ] Use ATS to issue or manage a tokenised asset
- [ ] Deploy and demonstrate on Hedera **testnet**
- [ ] Public GitHub repo; contracts verified on **HashScan** where applicable
- [ ] Demo video **≤5 min**: issuance + configuration + ≥1 lifecycle operation

**Prerequisites**

- [x] SDK surface verified against the installed 1.17.0 — §4.5's code does not exist → D40
- [ ] Hedera testnet operator account (portal.hedera.com); separate anchoring vs deploy accounts → D40
- [x] Network/connection wiring verified — SDK is browser-only, no headless signer → D42
- [x] Contracts package ships ABIs + Solidity, so headless KYC grants are viable → D42
- [ ] MetaMask (or HashPack) on Hedera testnet for the issuance screen → D42

**Issuance**

- [ ] `Bond.create(CreateBondRequest)` for a verified receivable — real fields: `isin`, `nominalValue`, `numberOfUnits`, `startingDate`, `maturityDate`, `couponFrequency`
- [ ] `internalKycActivated: true` so the token enforces KYC itself → D40
- [ ] Contract visible on HashScan

**Compliance — the differentiator**

- [ ] `SsiManagement.addIssuer` — register the platform as a trusted credential issuer → D40
- [x] Issue a verifiable credential when a wallet reaches CONFIRMED; the DigiLocker checks + nonce-bound attestation are what it asserts → D40. **Tested end to end** (`credential-issuance.test.ts`, 6): the real DigiLocker fixtures walk identity → control proof → binding → callback to CONFIRMED, then assert the credential exists, its EIP-712 signature **recovers to the configured issuer**, a tampered claim breaks that recovery, claims carry no name/address/PAN/Aadhaar digits, expiry tracks `aadhaarKycTtl`, and a missing issuer key fails closed without blocking confirmation
- [x] Dev issuer key generated; `ATS_ISSUER_PRIVATE_KEY` + `HEDERA_CHAIN_ID` documented in `.env.example` — they were not
- [x] Teardown in 4 existing test files made credential-aware. Turning the feature on meant confirmations started issuing credentials, and `VerifiableCredential.walletId` is `onDelete: Restrict` — so cleanup began failing on the FK while the tests themselves passed. 84 orphaned vendors from the crashed teardowns cleared. **Any new test that confirms a wallet now needs the same cleanup**
- [ ] On-chain call is `grantKyc(account, vcId, validFrom, validTo, issuer)` — reference only, no PII → D42
- [ ] `validTo` = `aadhaarKycTtl`, so a stale identity expires on chain by itself → D06, D42
- [ ] `Kyc.grantKyc({ securityId, targetId, vcBase64 })` driven by A8's registry as source of truth → D40
- [ ] `Kyc.revokeKyc` when a wallet is revoked
- [ ] **Demo the rejection**: transfer to a non-granted account fails on-chain

**Lifecycle — "real lifecycle management over a token with a name on it"**

- [ ] `setCoupon` / `getAllCoupons`
- [ ] `redeemAtMaturityByPartition` — maturity settlement
- [ ] HTLC settlement leg on Hedera (HSCS, EVM-compatible): claim-by-preimage doubles as the recipient acknowledgment; unclaimed refunds → D41
- [ ] Settlement mode is per-payment `direct | htlc`, never a replacement for plain transfer → D41

### B2 · Hedera — HCS evidence anchoring — *ungated*

- [ ] `anchorEvidence` job — Merkle root over unanchored records → D19
- [ ] Submit to HCS topic; `hcsAnchorTxId` backfilled onto every included record
- [ ] Inclusion proof verifiable for a single record against the anchored root

### B3 · Ledger — real device — *DEFERRED: no hardware wallet in scope (D32)*

- [-] Swap transport for `usb` (or `speculos`) — env change only, no code change; only if a device appears → D13, D32
- [ ] Clear Signing prompt shows correct recipient + amount on device
- [ ] Real send produces a real `txHash`; `PaymentRequest` → `SENT`

### B4 · World ID — Selfie Check — *DEMOTED below B1; keep the stub* → D39

- [ ] IDKit widget wired on the approval screen (QR desktop / deep link mobile)
- [ ] Server-side verification against World's endpoint — confirm response shape, do not guess field names
- [ ] `selfieCheckProofRef` stored opaque; proof never stored raw
- [ ] Widget success required before the proposal is written

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
