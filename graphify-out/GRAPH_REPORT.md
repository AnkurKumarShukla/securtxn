# Graph Report - securtxn-main  (2026-09-12)

## Corpus Check
- 293 files · ~178,383 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2111 nodes · 4617 edges · 145 communities (101 shown, 18 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 179 edges (avg confidence: 0.83)
- Token cost: 330,686 input · 0 output

## Community Hubs (Navigation)
- Decision Engine & Tiers
- CRE Vendor Matcher
- Approval Routes & Service
- Identity Verification Checks
- Onboarding Console UI
- Initial Data Model Migration
- Credential Issuance & Seed
- CRE End-to-End & Crypto
- World ID Nullifier Service
- Contracts Package Manifest
- Payee Consent & Challenge
- Securities Routes & Service
- HTLC Lifecycle Demo
- Payment Settlement
- Approval Bridge Manifest
- CRE Workflows Manifest
- HCS Anchor Gateway
- Bond Issuance & ISIN
- EIP-712 Message Builders
- Contract Deploy Scripts
- Payment Service & Acknowledgment
- Landing Page Sections
- API Config & Bootstrap
- Consent Flow Tests
- Evidence Chain & Canonical JSON
- ATS Compliance Gateway
- API Package Manifest
- Root Workspace Manifest
- Mock Chain Gateway
- Health & Lookup Routes
- Evidence Anchor Service
- Base TypeScript Config
- Dependency Injection Container
- API Fastify Dependencies
- API NPM Scripts
- Exception Desk Service
- Shared Types Manifest
- Approval Flow Tests
- Identity Provider Interface
- Payment Flow Tests
- Web Package Manifest
- World ID Web Widget
- Evidence Hash Chain Design
- Hedera Chain Gateway
- API Errors & Profile Parsing
- DigiLocker Provider
- Security Lifecycle
- Merkle Tree & Proofs
- Credential Issuance Tests
- Wallet Binding Tests
- Decision & Verification Model
- App Boundaries & DI Rationale
- Chain Gateway Interface
- Settlement Flow Tests
- Settle Flow Tests
- Landing Visual Effects
- World ID Selfie Check Feedback
- Server Bootstrap & TLS
- Exception Flow Tests
- Web TypeScript Config
- Web Runtime Dependencies
- Auth Roles & Tokens
- Pipeline Camera Animation
- Site Navigation
- React Bits UI Effects
- Confidential TEE Matching
- Testnet Deploy & Bond Issuer
- Mock Identity Provider
- Sanctions Screening
- Error Handler & Prisma Plugin
- World ID Route Tests
- Payment & Tokenization Models
- Identity Onboarding Design
- Dev Utility Routes
- API TypeScript Config
- Identity Registry Hook
- Match Request Scripts
- Chain Library Types
- Settlement Persistence Types
- Ledger Clear Signing Docs
- Bridge TypeScript Config
- Web Build Dependencies
- DigiLocker Fixture Tiers
- World ID Nullifier Design
- CRE Deployment Config
- API Dev Dependencies
- Anchor Flow Tests
- Securities Flow Tests
- Web NPM Scripts
- Brand Identity System
- Fixture Replay Oracle
- Agent Never Signs Principle
- No Raw PII On-Chain
- Contracts TypeScript Config
- CRE TypeScript Config
- Shared Types TypeScript Config
- Securities Custody Migration
- Identity Registry Tests
- Vendor Match Result Tests
- Web Root Layout
- Core Platform Deliverables
- World ID Verify Route
- Project Spec Overview
- Vendor Match Request Migration
- World ID Verification Migration
- Next.js API Rewrites
- World ID RP Signature Route
- Identity Callback Page
- On-Chain Mirror Tests
- Approvals Page Stub
- Evidence Viewer Stub
- Exceptions Page Stub
- Payment Detail Stub
- Payments List Stub
- Vendor Detail Stub
- New Vendor Stub
- Vendors List Stub
- Dev Certificate Script
- Monorepo Layout

## God Nodes (most connected - your core abstractions)
1. `UnprocessableError` - 53 edges
2. `@prisma/client` - 47 edges
3. `buildServer()` - 46 edges
4. `NotFoundError` - 45 edges
5. `Config` - 39 edges
6. `ConflictError` - 36 edges
7. `domainFor()` - 35 edges
8. `loadConfig()` - 31 edges
9. `fastify` - 26 edges
10. `HederaChainGateway` - 24 edges

## Surprising Connections (you probably didn't know these)
- `vendorMatch interface` --semantically_similar_to--> `Sanctions interface with MVP stub`  [INFERRED] [semantically similar]
  packages/cre-workflows/README.md → apps/api/README.md
- `Approver-local-only execution` --semantically_similar_to--> `CRE TEE workflow handler and VendorMatcher adapter`  [INFERRED] [semantically similar]
  apps/approval-bridge/README.md → packages/cre-workflows/README.md
- `Speculos transport switch` --semantically_similar_to--> `MockIdentityProvider fixture replayer`  [INFERRED] [semantically similar]
  apps/approval-bridge/README.md → fixtures/digilocker/README.md
- `Biometric stays inside World ID (D49)` --semantically_similar_to--> `Aadhaar last-4 display only`  [INFERRED] [semantically similar]
  fixtures/worldid/README.md → apps/web/README.md
- `Fallback as reference implementation` --semantically_similar_to--> `Synthetic DigiLocker fixture tier`  [INFERRED] [semantically similar]
  packages/cre-workflows/README.md → fixtures/digilocker-synthetic/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Identity-to-wallet binding chain (nonce-bound artifacts)** — docs_architecture_onboardingsessionnonce, docs_architecture_identity_binding, docs_architecture_digilockerprovider, docs_architecture_world_id_selfie_check, docs_architecture_vendorwallet [EXTRACTED 1.00]
- **IdentityProvider implementations sharing one contract suite** — docs_architecture_identityprovider, docs_architecture_digilockerprovider, docs_architecture_mockidentityprovider, docs_architecture_generickycprovider [EXTRACTED 1.00]
- **Track C — the gates one payment must pass through** — docs_progress_track_c_wiring, docs_payment_flow_sender_world_id_gate, docs_payment_flow_payee_consent, docs_payment_flow_cre_confidential_workflow, docs_payment_flow_decision_engine [EXTRACTED 1.00]
- **Propose-in-cloud, sign-on-device money movement flow** — apps_api_readme_never_signs_invariant, apps_web_readme_approval_writes_proposal, apps_approval_bridge_readme_local_machine_isolation, apps_approval_bridge_readme_approver_scoped_token, apps_approval_bridge_readme_clear_signing [EXTRACTED 1.00]
- **Two-tier fixture strategy and its replay seam** — fixtures_digilocker_readme_two_tier_strategy, fixtures_digilocker_readme_real_fixture_tier, fixtures_digilocker_synthetic_readme_synthetic_fixture_tier, fixtures_digilocker_readme_mockidentityprovider, fixtures_digilocker_synthetic_readme_digilocker_fixture_dir, fixtures_digilocker_readme_xmldsig_signature [EXTRACTED 1.00]
- **Swappable-implementation seams selected at the DI root** — apps_api_readme_container_di_root, packages_cre_workflows_readme_vendormatch_interface, packages_cre_workflows_readme_fallback_reference_impl, packages_cre_workflows_readme_cre_tee_handler, fixtures_digilocker_readme_mockidentityprovider, apps_api_readme_sanctions_stub, apps_approval_bridge_readme_speculos_transport [INFERRED 0.85]
- **SecurTxn Brand Identity System (glyph, palette, typography, a11y)** — apps_web_public_logo_securtxn_wordmark_lockup, apps_web_public_logo_shield_lock_glyph, apps_web_public_logo_dark_theme_palette, apps_web_public_logo_inter_font_stack, apps_web_public_logo_accessible_svg_labeling [INFERRED 0.85]

## Communities (145 total, 18 thin omitted)

### Community 0 - "Decision Engine & Tiers"
Cohesion: 0.05
Nodes (62): decide(), Decision, DecimalLike, DecisionInput, MatchResult, TierThresholds, WalletSnapshot, PLAYBOOKS (+54 more)

### Community 1 - "CRE Vendor Matcher"
Cohesion: 0.06
Nodes (48): CreVendorMatcher, CreVendorMatcherOptions, describe(), VendorMatchFailedError, VendorMatchRequestRecord, VendorMatchRequestStore, VendorMatchTimeoutError, INPUT (+40 more)

### Community 2 - "Approval Routes & Service"
Cohesion: 0.07
Nodes (37): approvalRoutes(), PaymentParams, ProposalParams, ApprovalService, ApprovalServiceDeps, PaymentRow, ProposalRow, toPendingProposal() (+29 more)

### Community 3 - "Identity Verification Checks"
Cohesion: 0.09
Nodes (48): checkCrossDocConsistency(), ConsistencyResult, IdentityCheckInput, IdentityCheckOutcome, runIdentityChecks(), sha256Hex(), checkSameSubjectLinkage(), LinkageResult (+40 more)

### Community 4 - "Onboarding Console UI"
Cohesion: 0.06
Nodes (46): AccountView, CHAIN_ID, ConsolePage(), OnChain(), S, STATE_COLOUR, WorldIdStep(), handleVerify() (+38 more)

### Community 5 - "Initial Data Model Migration"
Cohesion: 0.07
Nodes (49): "ApprovalEvent", ApprovalEvent_paymentRequestId_key, "EvidenceRecord", EvidenceRecord_hcsAnchorTxId_idx, EvidenceRecord_paymentRequestId_createdAt_idx, EvidenceRecord_paymentRequestId_previousRecordHash_key, "ExceptionCase", ExceptionCase_paymentRequestId_key (+41 more)

### Community 6 - "Credential Issuance & Seed"
Cohesion: 0.08
Nodes (37): config, main(), prisma, verifyIdentityBinding(), verifyWalletControl(), CredentialClaims, hashClaims(), issueCredential() (+29 more)

### Community 7 - "CRE End-to-End & Crypto"
Cohesion: 0.06
Nodes (39): base, CASES, container, nameHmac(), panHmac(), prisma, Ciphertext, decrypt() (+31 more)

### Community 8 - "World ID Nullifier Service"
Cohesion: 0.07
Nodes (29): nullifierToDecimal(), truncate(), Accepted, Body, IdKitProof, AcceptedProof, AcceptProofInput, DifferentHumanError (+21 more)

### Community 9 - "Contracts Package Manifest"
Cohesion: 0.04
Nodes (45): dependencies, @cp/shared-types, @hashgraph/sdk, viem, devDependencies, solc, tsx, @types/node (+37 more)

### Community 10 - "Payee Consent & Challenge"
Cohesion: 0.08
Nodes (32): verifyPayeeConsent(), ForbiddenError, assessPayeeChallenge(), CHALLENGE_TRIGGERS, ChallengeAssessment, ChallengeInput, ChallengeTrigger, MISMATCH_WINDOW_DAYS (+24 more)

### Community 11 - "Securities Routes & Service"
Cohesion: 0.14
Nodes (24): UnprocessableError, SecurityParams, securityRoutes(), SweepResult, address(), fromBaseUnits(), randomIsinBody(), SecurityRow (+16 more)

### Community 12 - "HTLC Lifecycle Demo"
Cohesion: 0.10
Nodes (24): lockPayload(), ACCESS_CONTROL_ABI, loadEnv(), main(), required(), TOKEN_ABI, PAYMENT_HTLC_ABI, PAYMENT_HTLC_BYTECODE (+16 more)

### Community 13 - "Payment Settlement"
Cohesion: 0.15
Nodes (14): verifySecretRelease(), ConflictError, paymentRoutes(), PaymentSettler, PaymentSettlerDeps, SettlementService, toSettlementSummary(), writeLockRecord() (+6 more)

### Community 14 - "Approval Bridge Manifest"
Cohesion: 0.06
Nodes (32): bin, approval-bridge, dependencies, commander, @cp/shared-types, undici, viem, zod (+24 more)

### Community 15 - "CRE Workflows Manifest"
Cohesion: 0.06
Nodes (30): default, types, dependencies, @chainlink/cre-sdk, @cp/shared-types, zod, devDependencies, dotenv-cli (+22 more)

### Community 16 - "HCS Anchor Gateway"
Cohesion: 0.10
Nodes (11): AnchorGateway, AnchorReceipt, createAnchorGateway(), HcsGateway, MockAnchorGateway, loadEnv(), main(), required() (+3 more)

### Community 17 - "Bond Issuance & ISIN"
Cohesion: 0.14
Nodes (24): BOND_LIFECYCLE_ABI, BondIssuerOptions, completeIsin(), CONFIG_ID, DEFAULT_PARTITION, FACTORY_ABI, isinCheckDigit(), IssueBondInput (+16 more)

### Community 18 - "EIP-712 Message Builders"
Cohesion: 0.12
Nodes (24): Call, config, digilocker(), messageOf(), must(), payee, AcknowledgmentMessage, IdentityBindingMessage (+16 more)

### Community 19 - "Contract Deploy Scripts"
Cohesion: 0.13
Nodes (21): ACCESS_CONTROL_ABI, loadEnv(), main(), required(), ACCESS_CONTROL_ABI, loadEnv(), main(), required() (+13 more)

### Community 20 - "Payment Service & Acknowledgment"
Cohesion: 0.16
Nodes (16): buildAcknowledgmentMessage(), verifyAcknowledgment(), NotFoundError, recommendSettlementMode(), PaymentParams, commitmentFor(), commitmentOver(), displayName() (+8 more)

### Community 21 - "Landing Page Sections"
Cohesion: 0.12
Nodes (14): Footer(), Hero(), HowItWorks(), Eyebrow(), Lede(), Section(), SectionHeading(), CHAIN (+6 more)

### Community 22 - "API Config & Bootstrap"
Cohesion: 0.12
Nodes (16): AmountOrZero, booleanish, Config, EnvSchema, hex32, loadConfig(), loadEnvFile(), withoutEmptyValues() (+8 more)

### Community 23 - "Consent Flow Tests"
Cohesion: 0.15
Nodes (23): buildPayeeConsentMessage(), auth(), base, hasRealFixtures, onboardedPayee(), PAYEE, prisma, REAL_FIXTURES (+15 more)

### Community 24 - "Evidence Chain & Canonical JSON"
Cohesion: 0.17
Nodes (16): canonicalJsonStringify(), serialise(), canonicalize(), ChainRecord, ChainVerification, computeRecordHash(), verifyChain(), EvidenceService (+8 more)

### Community 25 - "ATS Compliance Gateway"
Cohesion: 0.10
Nodes (9): AtsComplianceGateway, AtsGatewayOptions, ComplianceGateway, ComplianceResult, GrantKycInput, key(), MockComplianceGateway, NO_EXPIRY_SECONDS (+1 more)

### Community 26 - "API Package Manifest"
Cohesion: 0.09
Nodes (21): @cp/shared-types, dotenv-cli, tsx, typescript, viem, vitest, @worldcoin/idkit-core, zod (+13 more)

### Community 27 - "Root Workspace Manifest"
Cohesion: 0.09
Nodes (21): devDependencies, @types/node, typescript, vitest, engines, node, @types/node, typescript (+13 more)

### Community 28 - "Mock Chain Gateway"
Cohesion: 0.20
Nodes (5): holdingKey(), key(), MockChainGateway, randomAddress(), syntheticHash()

### Community 29 - "Health & Lookup Routes"
Cohesion: 0.13
Nodes (16): buildLoggerOptions(), LoggerOptions, REDACT_PATHS, HealthResponse, healthRoutes(), ReadyResponse, Params, VendorLookupResponse (+8 more)

### Community 30 - "Evidence Anchor Service"
Cohesion: 0.20
Nodes (13): ALGORITHM, AnchorRow, AnchorService, AnchorServiceDeps, toAnchorSummary(), withPrefix(), evidenceRoutes(), PaymentParams (+5 more)

### Community 31 - "Base TypeScript Config"
Cohesion: 0.10
Nodes (20): compilerOptions, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, lib (+12 more)

### Community 32 - "Dependency Injection Container"
Cohesion: 0.17
Nodes (16): createTierThresholds(), Container, containerPlugin(), createContainer(), createCreVendorMatcher(), fastify, FastifyInstance, createChainGateway() (+8 more)

### Community 33 - "API Fastify Dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @cp/contracts, @cp/cre-workflows, @cp/shared-types, fastify, @fastify/cors, @fastify/helmet, @fastify/jwt (+11 more)

### Community 34 - "API NPM Scripts"
Cohesion: 0.11
Nodes (19): scripts, build, cert:dev, cre:e2e, cre:request, cre:show, db:deploy, db:migrate (+11 more)

### Community 35 - "Exception Desk Service"
Cohesion: 0.25
Nodes (11): playbookFor(), CaseParams, exceptionRoutes(), ExceptionService, ExceptionServiceDeps, toSummary(), ExceptionStatus, CreateExceptionRequest (+3 more)

### Community 36 - "Shared Types Manifest"
Cohesion: 0.11
Nodes (18): dependencies, zod, devDependencies, typescript, vitest, exports, typescript, vitest (+10 more)

### Community 37 - "Approval Flow Tests"
Cohesion: 0.14
Nodes (13): prisma, approvablePayment(), asAgent(), base, hasRealFixtures, onboardedVendor(), PAYEE, prisma (+5 more)

### Community 38 - "Identity Provider Interface"
Cohesion: 0.22
Nodes (7): NotImplementedError, IdentityProvider, IdentityResult, SessionStatus, GenericKycProvider, MockIdentityProviderOptions, MockSession

### Community 39 - "Payment Flow Tests"
Cohesion: 0.14
Nodes (16): draftPayment(), fixtureOracle, hasRealFixtures, REAL_FIXTURE_DIR, REPO_ROOT, clearWorldIdRows(), auth(), base (+8 more)

### Community 40 - "Web Package Manifest"
Cohesion: 0.12
Nodes (16): @cp/shared-types, typescript, viem, vitest, @worldcoin/idkit-core, zod, name, private (+8 more)

### Community 41 - "World ID Web Widget"
Cohesion: 0.20
Nodes (11): Props, S, S, Stage, WorldIdTestPage(), WORLD_ACTION, WORLD_APP_ID, WORLD_ENVIRONMENT (+3 more)

### Community 42 - "Evidence Hash Chain Design"
Cohesion: 0.15
Nodes (17): canonicalize() deterministic JSON, computeRecordHash(), Evidence hash chain, Principle 3 — every state change produces an evidence record, EvidenceRecord model, Batch HCS Merkle anchoring job, Check 1 — XMLDSig signature verification, lib/canonical-json.ts key ordering rule (+9 more)

### Community 44 - "API Errors & Profile Parsing"
Cohesion: 0.17
Nodes (9): AppError, BadRequestError, UnauthorizedError, parseProfile(), ProfileData, ProfileEnvelope, UserProfile, DigiLockerProviderOptions (+1 more)

### Community 45 - "DigiLocker Provider"
Cohesion: 0.23
Nodes (4): describeFailure(), DigiLockerProvider, normaliseStatus(), DocType

### Community 47 - "Merkle Tree & Proofs"
Cohesion: 0.28
Nodes (13): expect(), main(), RFC-6962, buildTree(), hashLeaf(), hashNode(), merkleProof, MerkleProofStep (+5 more)

### Community 48 - "Credential Issuance Tests"
Cohesion: 0.16
Nodes (14): buildIdentityBindingMessage(), buildWalletControlMessage(), withPrefix(), authFor(), base, confirmedVendor(), hasRealFixtures, ISSUER_KEY (+6 more)

### Community 49 - "Wallet Binding Tests"
Cohesion: 0.22
Nodes (14): auth(), base, createVendor(), fullyBoundVendor(), grantable(), hasRealFixtures, OTHER, PAYEE (+6 more)

### Community 50 - "Decision & Verification Model"
Cohesion: 0.17
Nodes (15): registryVerifiedContact independent-channel callback control, decide() decision engine state machine, GET /internal/identity-registry/:address hook, PaymentDecision (SAFE_TO_SEND / DO_NOT_SEND / REVERIFY / SEND_TEST_AMOUNT), Check 3 — same-subject linkage, TierThresholds config, Check 4 — KYC TTL enforcement, Vendor model (+7 more)

### Community 51 - "App Boundaries & DI Rationale"
Cohesion: 0.21
Nodes (14): container.ts DI root, @cp/api core platform, API process never signs, Vertical slice module layout, api-client.ts sole network surface, Approver-scoped token, @cp/approval-bridge, Approver-local-only execution (+6 more)

### Community 53 - "Settlement Flow Tests"
Cohesion: 0.18
Nodes (12): claimDigests(), auth(), base, ESCROW, PAYEE, PAYER, paymentIds, post() (+4 more)

### Community 54 - "Settle Flow Tests"
Cohesion: 0.21
Nodes (11): approvedPayment(), base, expiredLock(), fundTreasury(), lockedPayment(), PAYEE, paymentIds, prisma (+3 more)

### Community 55 - "Landing Visual Effects"
Cohesion: 0.22
Nodes (9): COLUMNS, FadedRule(), GhostButton(), PrimaryButton(), Prism(), PrismProps, ShinyText(), ShinyTextProps (+1 more)

### Community 56 - "World ID Selfie Check Feedback"
Cohesion: 0.19
Nodes (14): onboardingSessionNonce session binding, World ID Selfie Check (approver second factor), Assurance boundaries — do not overclaim, P2 sender World ID check, every payment, B4 World ID Selfie Check integration, Track C — wiring the sponsor integrations into the flow, created_at is first-seen, not verified-at, No way to read whether Selfie Check is enabled for an app (+6 more)

### Community 57 - "Server Bootstrap & TLS"
Cohesion: 0.21
Nodes (10): expect(), main(), buildSecretReleaseMessage(), httpsEnforcementPlugin(), tlsServerOptions, identityRegistryRoutes(), worldIdRoutes(), swaggerPlugin() (+2 more)

### Community 58 - "Exception Flow Tests"
Cohesion: 0.18
Nodes (11): auth(), base, hasRealFixtures, onboardedVendor(), OTHER, PAYEE, prisma, REAL_FIXTURES (+3 more)

### Community 59 - "Web TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, allowJs, incremental, jsx, lib, noEmit, paths, plugins (+4 more)

### Community 60 - "Web Runtime Dependencies"
Cohesion: 0.17
Nodes (12): dependencies, @cp/shared-types, gsap, motion, next, ogl, react, react-dom (+4 more)

### Community 61 - "Auth Roles & Tokens"
Cohesion: 0.24
Nodes (7): fastify, FastifyInstance, FastifyRequest, TokenPayload, VERIFIER, Role, @fastify/jwt

### Community 62 - "Pipeline Camera Animation"
Cohesion: 0.24
Nodes (7): Artifact, centerOf(), PipelineCamera(), Rail(), Stage, StageGroup(), STAGES

### Community 63 - "Site Navigation"
Cohesion: 0.22
Nodes (7): ITEMS, SiteNav(), CardNav(), CardNavItem, CardNavLink, CardNavProps, gsap

### Community 64 - "React Bits UI Effects"
Cohesion: 0.18
Nodes (8): CountUp(), CountUpProps, LetterGlitch(), LetterGlitchProps, Position, SpotlightCard(), SpotlightCardProps, react

### Community 65 - "Confidential TEE Matching"
Cohesion: 0.29
Nodes (11): Principle 4 — confidential vendor matching runs in a TEE, CRE TEE vendor-match workflow (cre.handlerInTee), FallbackVendorMatcher (non-confidential), VendorMatcher interface, The address is untrusted routing; the identity is the verification, P6 CRE confidential workflow (TEE digest comparison), Digest matching in the enclave (D62), evaluateMatch() shared match rule (+3 more)

### Community 66 - "Testnet Deploy & Bond Issuer"
Cohesion: 0.33
Nodes (5): loadEnv(), main(), required(), BondIssuer, extractDeployedAddress()

### Community 68 - "Sanctions Screening"
Cohesion: 0.47
Nodes (5): createSanctionsScreener(), SanctionsQuery, SanctionsResult, SanctionsScreener, StubSanctionsScreener

### Community 69 - "Error Handler & Prisma Plugin"
Cohesion: 0.22
Nodes (8): body(), CODE_BY_STATUS, ErrorBody, errorHandlerPlugin(), fastify, FastifyInstance, prismaPlugin(), fastify

### Community 70 - "World ID Route Tests"
Cohesion: 0.20
Nodes (5): base, capture, FIXTURES, prisma, subjects

### Community 71 - "Payment & Tokenization Models"
Cohesion: 0.22
Nodes (10): ApprovalEvent model, ExceptionCase model, Hedera ATS receivable tokenization, PaymentRequest model, RecipientAcknowledgment model, P9-P11 HTLC lock / claim / refund, Payment flow (O1-O8, P1-P12), B1 Hedera ATS track (+2 more)

### Community 72 - "Identity Onboarding Design"
Cohesion: 0.22
Nodes (10): Check 2 — cross-document consistency, DigiLockerProvider (India, Sandbox aggregator), Two fixture tiers (real gitignored, synthetic committed), GenericKycProvider (Persona/Onfido/Sumsub), Identity-to-wallet binding (EIP-712 IdentityBinding), IdentityProvider interface, MockIdentityProvider (fixture replay), Mandatory format normalisation before comparison (+2 more)

### Community 73 - "Dev Utility Routes"
Cohesion: 0.25
Nodes (8): AccountView, devRoutes(), escapeHtml(), ReleaseRequest, ReleaseResponse, TokenRequest, TokenResponse, TreasuryResponse

### Community 74 - "API TypeScript Config"
Cohesion: 0.22
Nodes (8): compilerOptions, outDir, rootDir, types, exclude, extends, include, ../../tsconfig.base.json

### Community 75 - "Identity Registry Hook"
Cohesion: 0.25
Nodes (8): Identity module and the four checks, internal identity-registry hook, crossDocConsistent check, Three-way format inconsistency (date, gender, name case), Control List module, @cp/contracts, deployReceivable factory deploy, KYC data as ERC-3643 compliance backend

### Community 76 - "Match Request Scripts"
Cohesion: 0.32
Nodes (7): canonicalName(), CASES, hmacOf(), nameHmac(), payload, prisma, SUFFIXES

### Community 77 - "Chain Library Types"
Cohesion: 0.25
Nodes (5): IssuedSecurity, IssueSecurityInput, LockInput, LockOutput, CouponTerms

### Community 78 - "Settlement Persistence Types"
Cohesion: 0.25
Nodes (7): SettlementRow, SettlementServiceDeps, TxClient, WriteLockArgs, RecordClaimRequest, RecordLockRequest, RecordRefundRequest

### Community 79 - "Ledger Clear Signing Docs"
Cohesion: 0.32
Nodes (8): Clear Signing on-device confirmation, Speculos transport switch, wallet-cli execa wrapper, Ledger AI tools and CLI docs, Ledger Clear Signing / ERC-7730 docs, Ledger device-app and Ledger OS docs, Ledger Device Management Kit docs, Ledger developer docs URL index

### Community 80 - "Bridge TypeScript Config"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, types, extends, include, ../../tsconfig.base.json

### Community 81 - "Web Build Dependencies"
Cohesion: 0.25
Nodes (8): devDependencies, postcss, tailwindcss, @tailwindcss/postcss, @types/react, @types/react-dom, typescript, vitest

### Community 82 - "DigiLocker Fixture Tiers"
Cohesion: 0.29
Nodes (8): Aadhaar last-4 display only, Real DigiLocker fixture tier, Vendor test environment rejected, Two-tier fixture strategy, XMLDSig signatures from UIDAI and Income Tax Department, Deliberately preserved format gotchas, Synthetic DigiLocker fixture tier, Test CA root for synthetic signatures

### Community 83 - "World ID Nullifier Design"
Cohesion: 0.32
Nodes (8): Medium-assurance copy constraint, World ID Selfie Check widget, Biometric stays inside World ID (D49), Nullifier as scoped pseudonym, Nullifier continuity property, World ID Selfie Check fixtures, UNIQUE (nullifier, action, signal) constraint, Empty-signal proof binding

### Community 84 - "CRE Deployment Config"
Cohesion: 0.32
Nodes (8): CRE project staging/production settings, Unused-but-required RPC configuration, Vault DON secrets on the mainnet registry, CRE TEE workflow handler and VendorMatcher adapter, cre workflow simulate is not a security demonstration, Adapted workflow artifact paths, private deployment-registry choice, vendor-match-staging workflow settings

### Community 85 - "API Dev Dependencies"
Cohesion: 0.29
Nodes (7): devDependencies, dotenv-cli, pino-pretty, prisma, tsx, typescript, vitest

### Community 86 - "Anchor Flow Tests"
Cohesion: 0.38
Nodes (6): auth(), base, get(), paymentIds, post(), prisma

### Community 87 - "Securities Flow Tests"
Cohesion: 0.38
Nodes (6): asIssuer(), base, inOneYear(), issue(), prisma, securityIds

### Community 88 - "Web NPM Scripts"
Cohesion: 0.29
Nodes (7): scripts, build, dev, lint, start, test, typecheck

### Community 89 - "Brand Identity System"
Cohesion: 0.38
Nodes (7): Accessible SVG Labeling (role=img, aria-label), Dark-Theme Brand Palette (#7ea6ff accent, #f5f7fa text), Static Public Inline SVG Asset, Inter System Font Stack, Security Trust Signal Branding, SecurTxn Wordmark Lockup, Shield-with-Lock Glyph

### Community 90 - "Fixture Replay Oracle"
Cohesion: 0.29
Nodes (7): Local DigiLocker consent stub page, index.json expected_check_results oracle, MockIdentityProvider fixture replayer, Short-lived presigned document URLs, TIER3_ADDRESS resulting tier, DIGILOCKER_FIXTURE_DIR switch, index.json known_gotchas oracle

### Community 91 - "Agent Never Signs Principle"
Cohesion: 0.29
Nodes (7): Principle 1 — the agent never holds a private key, apps/approval-bridge, agent / approver role separation at the API layer, Ledger Clear Signing on-device confirmation, Principle 5 — signing and read-only are separate processes, Open gap: nothing broadcasts a transfer, approval-bridge is a separate app, not a module

### Community 92 - "No Raw PII On-Chain"
Cohesion: 0.29
Nodes (7): Principle 2 — no raw PII on-chain, commitment hashes only, World ID nullifier never written to the chain, The PII rule for evidence payloads, world_id_check evidence event, Known residual: the one-bit leak, P5 payee challenge triggers (risk-based), Row-level security on every public table (D46)

### Community 93 - "Contracts TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 94 - "CRE TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 95 - "Shared Types TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 96 - "Securities Custody Migration"
Cohesion: 0.60
Nodes (5): "Security", Security_evmAddress_key, Security_status_idx, "SecurityEvent", SecurityEvent_securityId_createdAt_idx

### Community 97 - "Identity Registry Tests"
Cohesion: 0.33
Nodes (3): base, prisma, walletIds

### Community 98 - "Vendor Match Result Tests"
Cohesion: 0.33
Nodes (3): base, prisma, requestIds

### Community 99 - "Web Root Layout"
Cohesion: 0.33
Nodes (4): inter, metadata, viewport, next

### Community 100 - "Core Platform Deliverables"
Cohesion: 0.40
Nodes (5): Evidence hash-chain, HCS anchoring job, Pure decision state machine, Sanctions interface with MVP stub, Evidence chain viewer

### Community 101 - "World ID Verify Route"
Cohesion: 0.50
Nodes (4): dynamic, POST(), runtime, safeJson()

### Community 102 - "Project Spec Overview"
Cohesion: 0.50
Nodes (5): Non-negotiable design principles, System architecture (web / api / bridge / CRE / contracts / Hedera), Gap: vendor-level events have no evidence chain, Progress checklist, Confirmed Payee + Exception Desk

### Community 103 - "Vendor Match Request Migration"
Cohesion: 0.83
Nodes (3): "VendorMatchRequest", VendorMatchRequest_status_createdAt_idx, VendorMatchRequest_vendorId_createdAt_idx

### Community 104 - "World ID Verification Migration"
Cohesion: 0.83
Nodes (3): "WorldIdVerification", WorldIdVerification_nullifier_action_signal_key, WorldIdVerification_subject_purpose_verifiedAt_idx

## Ambiguous Edges - Review These
- `Speculos transport switch` → `Ledger device-app and Ledger OS docs`  [AMBIGUOUS]
  ledger_all_urls.txt · relation: conceptually_related_to

## Knowledge Gaps
- **619 isolated node(s):** `name`, `version`, `private`, `type`, `main` (+614 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 839 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Speculos transport switch` and `Ledger device-app and Ledger OS docs`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `react` connect `React Bits UI Effects` to `Onboarding Console UI`, `Web Package Manifest`, `World ID Web Widget`, `Landing Page Sections`, `Landing Visual Effects`, `Pipeline Camera Animation`, `Site Navigation`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `@prisma/client` connect `Approval Flow Tests` to `Decision Engine & Tiers`, `Approval Routes & Service`, `Credential Issuance & Seed`, `CRE End-to-End & Crypto`, `World ID Nullifier Service`, `Payee Consent & Challenge`, `Securities Routes & Service`, `Payment Settlement`, `Payment Service & Acknowledgment`, `API Config & Bootstrap`, `Consent Flow Tests`, `Evidence Chain & Canonical JSON`, `API Package Manifest`, `Evidence Anchor Service`, `Dependency Injection Container`, `Exception Desk Service`, `Payment Flow Tests`, `Credential Issuance Tests`, `Wallet Binding Tests`, `Settlement Flow Tests`, `Settle Flow Tests`, `Server Bootstrap & TLS`, `Exception Flow Tests`, `Error Handler & Prisma Plugin`, `World ID Route Tests`, `Match Request Scripts`, `Settlement Persistence Types`, `Anchor Flow Tests`, `Securities Flow Tests`, `Identity Registry Tests`, `Vendor Match Result Tests`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `index.json expected_check_results oracle` connect `Fixture Replay Oracle` to `Identity Registry Hook`, `Payment Flow Tests`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Are the 22 inferred relationships involving `buildServer()` (e.g. with `containerPlugin()` and `httpsEnforcementPlugin()`) actually correct?**
  _`buildServer()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _619 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Decision Engine & Tiers` be split into smaller, more focused modules?**
  _Cohesion score 0.054706163401815576 - nodes in this community are weakly interconnected._