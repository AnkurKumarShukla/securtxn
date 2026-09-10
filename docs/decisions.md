# Decisions

High-stakes architecture + business-logic decisions only. Referenced by `→ Dnn`
from [progress.md](./progress.md).

**Source** — `spec`: inherited from [architecture.md](./architecture.md), recorded here
because it governs implementation. `build`: made while building.

---

## Data model

### D01 · Vendor and VendorWallet as separate tables — `spec`
- identity is stable, wallets rotate — 1:N, not columns on Vendor
- `version` + `supersededById` = append-only history; old wallet row never mutated
- post-incident question "which address was CONFIRMED on date X" must be answerable
- a wallet change is the highest-risk event in the system → needs its own row to gate, not an UPDATE

### D02 · `digilockerUserId` is the identity primary key, not the Aadhaar number — `spec`
- full Aadhaar never exposed by DigiLocker (masked `xxxxxxxx1234`) — not an option anyway
- stable pseudonymous id, appears in **both** PAN `Person uid` and Aadhaar `KycRes txn` → doubles as the same-subject check
- receiving/storing a full Aadhaar triggers Aadhaar Data Vault obligations — avoided by design
- consequence: no UI may ever accept a typed Aadhaar number

### D03 · Identity, key custody and liveness bound by one shared nonce — `spec`
- each check can pass individually while belonging to **different people**
- attack: genuine borrowed/bought KYC session + attacker's own wallet signature → every check green
- `onboardingSessionNonce` identical across liveness + document + EIP-712 signature; mismatch = reject
- EIP-712 payload includes nonce + `digilockerUserId` + wallet + both doc hashes → payee signs the binding, not just the key
- turns a false detail into a repudiation-resistant act by the payee, not a record-keeping failure by us

### D04 · Unverified identity is never persisted as usable — `spec`
- parsing signed XML without verifying XMLDSig discards the entire security property — it is just a text file
- `xmlSignatureVerified` + `crossDocConsistent` both required before CONFIRMED
- cross-doc mismatch treated as a fraud signal, not data-entry noise
- endpoint returns 422 rather than storing a "pending review" row → no state where bad identity sits in the table looking valid

### D05 · `registryVerifiedContact` never sourced from the current submission — `spec`
- attack: real company name + tax ID + attacker's own phone → attacker confirms their own fraud on callback
- new vendor → contact from independent registry lookup; existing vendor → contact on file predating the change
- server-side rejection, not a UI convention
- seed hardcodes a value so the control still executes in demos — never ship a "skip for demo" branch

### D06 · Verification is time-bounded, PII minimised at capture — `spec`
- `aadhaarKycTtl` from `KycRes.ttl` (~issue + 1yr) → CONFIRMED expires; re-verification scheduled before it
- store `aadhaarLast4` only; PAN as `panNumberHmac`; DOB / address / photo encrypted at rest
- UIDAI rules prohibit sharing or displaying document contents → RBAC + every read logged as evidence
- nothing PII on-chain, encrypted or not — commitment hashes only

### D07 · Evidence chain written in the same transaction as the state change — `spec`
- a record written after commit can be lost → chain would claim a completeness it does not have
- `previousRecordHash` links records; genesis is `"0"` × 64
- deterministic sorted-key canonicalisation — `JSON.stringify` key order is not guaranteed across engines
- verification recomputes from genesis and reports the **break index**, not just a boolean

---

## Platform architecture

### D08 · Decision engine is one pure function with config-injected thresholds — `spec` + `build`
- explicit state machine, not if/else scattered across payment routes → every branch auditable
- no DB or network imports → testable without a database; a decision cannot silently depend on request context
- tier thresholds are per-customer risk appetite → config, never literals
- `verificationTier` is an input: high-value payment to a TIER1 payee returns REVERIFY, not SAFE_TO_SEND

### D09 · Every access-gated dependency behind an interface, resolved in one DI root — `spec` + `build`
- 3 of 4 external integrations are gated (CRE beta, World ID flag, Ledger hardware) — §8
- `IdentityProvider`, `VendorMatcher`, `SanctionsScreener` → Phases 1–3 unblocked regardless of how gates resolve
- both implementations of each pass **one** shared test suite → the swap is provably behaviour-preserving
- resolved only in `apps/api/src/container.ts` → swap is one line; callers never learn which is active
- fallback is the reference implementation, not throwaway
- `cre-workflows` cannot depend on Prisma → fallback takes an injected `VendorLookup`; shared `scoring/` so enclave and fallback cannot disagree on what a match is

### D10 · Normalisation is its own layer, ahead of the consistency check — `spec` + `build`
- same person formatted 3 ways across endpoints: date `19/11/2001` vs `19-11-2001`; gender `male` / `M` / `MALE`; name case
- naive equality rejects a **legitimate** user — spec calls this the most likely bug in the integration
- profile `date_of_birth` documented as unix-ms, observed as `DD/MM/YYYY` → handle both types
- own directory + own tests, not buried inside a parser

### D11 · Two fixture tiers, synthetic one deliberately messy — `spec` + `build`
- redaction impossible: one edited byte invalidates XMLDSig → real-and-secret or synthetic-and-unsigned, no middle ground
- real tier gitignored (a real person's Aadhaar + PAN); synthetic tier committed, runs CI
- synthetic set must **reproduce** the three format inconsistencies — a tidy fixture passes CI and fails live
- identical layout in both → `DIGILOCKER_FIXTURE_DIR` switches tiers with no code change
- signature-verification assertions belong to the real tier only

### D12 · Signing and read-only are separate processes, and separate roles — `spec`
- `approval-bridge` is its own app with its own dependency tree, on the approver's machine — not a module in `api`
- autonomous code writes proposals; only a human + on-device Clear Signing moves funds
- `agent` and `approver` are mutually exclusive scopes enforced in middleware; a test asserts the 403
- bridge imports nothing from `api` — HTTP only → no accidental in-process path to a key
- each role verifies against its **own** JWT secret, so a wrong-role token fails signature verification (401) before any role string is compared — config rejects shared secrets at boot
- **partly superseded by D51**: a consumer UI cannot drive a terminal, so the API now signs issuance, minting and settlement itself. What survives is role separation and the approval gate; what is gone is "the API process cannot move money"

### D13 · Transport is the only thing Speculos changes — `build`
- `WALLET_CLI_TRANSPORT=usb|speculos` switches the target; code path identical
- a Speculos demo therefore exercises the real flow, not a parallel mock path

---

## Code organisation

### D14 · Vertical slices in `apps/api`, not `routes/` + `services/` — `build`
- each domain owns routes + service + schema together → one endpoint = one directory
- parallel trees force edits across 4 distant files and drift apart
- cross-module calls go through a service, never another module's routes

### D15 · Auditable logic kept pure — `build`
- `decision/` and `evidence/chain.ts` have no DB or network imports
- the two things the product's credibility rests on are unit-testable in isolation
- `DecisionInput.amount` is typed `DecimalLike` (a structural `gt`/`toString`), which Prisma's `Decimal` satisfies — exact money comparison without importing the ORM

### D16 · Strict TS options at the workspace root — `build`
- `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — this codebase is full of optional PII fields where `undefined` vs `null` vs `""` changes meaning
- inherited by every package → a new package cannot quietly opt out

### D17 · Mock mode never short-circuits to `succeeded` — `spec`
- mock `authorizationUrl` points at a local consent stub page that flips `created` → `succeeded`
- keeps the real polling path exercised → status-loop bugs surface in dev, not on the one live run
- human consent is the single step mocking cannot reproduce — and is what makes DigiLocker legally defensible

### D18 · Reading the audit trail is itself audited — `spec`
- every `GET /payments/:id/evidence` writes an `evidence_accessed` record
- PII access must be attributable; an unlogged read of an audit log is a gap

### D19 · Evidence anchored in batches, not per record — `spec`
- Merkle root of unanchored records → HCS topic every ~15 min
- per-record anchoring costs and rate-limits badly; a root proves inclusion for the whole batch
- `hcsAnchorTxId` backfilled onto every included record
- **built — see D52** for the Merkle choices, why verification is a separate step, and the two deployment bugs it surfaced

---

## Sequencing

### D20 · Core built stub-backed first; partners integrated one at a time after — `build`

- partner blockers are **wall-clock** blocked (someone else replies); core work is **effort** blocked (we control it) → run them in parallel, never serially
- worst case avoided: one partner (Ledger) eats the time and *nothing* ships — neither integrations nor a working app
- access requests fired in Phase 0, before any integration code — the waiting is the long pole, not the code
- integration order by gate control, not by ease: Hedera (ungated) → Ledger (device) → World ID (flag) → CRE (private beta, likeliest to never clear)
- one partner per branch; merge only when working end-to-end — a half-integrated partner on `main` breaks a working demo
- core-complete commit is tagged as the guaranteed fallback demo

**Three things that are core work, not partner work** — cheap now, a rewrite later:

- **approval boundary** — process split + agent/approver scopes (D12). Device is deferrable; the boundary is not: retrofitting touches the auth layer and every payment route
- **`/internal/identity-registry/:address`** — ATS calls *in*; no partner dependency exists. A `VendorWallet.status` lookup
- **evidence hash chain** — must be correct before anchoring. A root published over a broken chain cannot be retroactively fixed (D07, D19)

**Interface risk is not uniform** — shape the stub against the real SDK surface first, where it is unknown:

- DigiLocker verified end-to-end · CRE API shape verified in spec → no risk
- Hedera ATS signatures explicitly unverified (§4.5) → read the installed SDK before stubbing
- World ID server-side response shape undocumented → keep `selfieCheckProofRef` opaque, never guess field names

### D21 · A stub is a named implementation behind an interface, never a blank route — `build`

- blank route returning 200 is indistinguishable from success → integration tests go green, happy path gets built on top, failure branches never execute once
- unimplemented routes return **501**, not 200
- stub must not decide: `StubSanctionsScreener` always returns `false`, so the `sanctionsHit: true` branch is tested by **injecting the input directly** — otherwise that branch has literally never run
- same for DigiLocker rejection paths — bad signature, cross-doc mismatch, nonce mismatch, all injected
- `FallbackVendorMatcher` is exempt: it is real logic, not a stub (D09). A dummy `{ match: true, score: 1.0 }` makes every decision-engine test meaningless
- failure mode this guards: "core complete with stubs" feels like 90% done at 60%

### D22 · Invalid configuration is a startup failure, never a runtime surprise — `build`

- every env var parsed and validated by Zod at boot; the process exits rather than starting half-configured
- a missing secret must not become a 500 on the one request that needed it, hours later
- credential **format** asserted, not just presence: `SANDBOX_LIVE_SECRET` must start with `secret_live_`, `SANDBOX_LIVE_KEY` with `key_live_` — this repo already shipped the key pasted into both slots once, and live it surfaces as an opaque 401
- conditional requirements: selecting `IDENTITY_PROVIDER=digilocker` makes its three credentials mandatory
- the three role secrets must differ, or D12's separation is decoration
- `ENABLE_DOCS` must be false in production
- validation errors print offending **keys and reasons only** — never values

### D23 · OpenAPI generated from the same Zod schemas the routes validate against — `build`

- one description of each request shape, not two → docs cannot drift from enforcement
- a route's schema is simultaneously the validator, the response serializer, and the published contract
- `/swagger` is browsable with an Authorize button, so the API is testable without Postman or curl recipes
- consequence: an undocumented route is a route with no validation — the omission is visible

### D24 · Development-only capability is absent in production, not disabled — `build`

- `POST /dev/token` mints role-scoped tokens; it is registered only when `NODE_ENV !== production`
- a token-minting endpoint guarded by a boolean is one misconfigured env var away from being reachable
- absence is not configurable; a flag is

### D25 · Schema deviations from §3 — constraints the prose implied but the schema block did not — `build`

§3 stays the source of truth for shapes. Five additions, each an integrity rule
already stated in the surrounding text:

- **`EvidenceRecord` unique on `(paymentRequestId, previousRecordHash)`** — §3 ordered the chain by `createdAt`, but two records written in one transaction can share a timestamp, leaving the order (and so the chain) ambiguous. Uniqueness on the link means the chain is reconstructed by following `previousRecordHash`, and a fork is rejected by the database rather than discovered during verification
- **`VendorWallet` unique on `(vendorId, version)`** — two wallets at one version make the rotation history ambiguous, and with it "which address was CONFIRMED on date X" (D01). §3 had a plain index
- **`supersededById` as a real self-relation** — a dangling pointer would silently break that same history
- **`amount` at `Decimal(38,18)`** — ERC-20 stablecoins carry 18 decimals; leaving Prisma's default risks silent rounding on a value that moves money irreversibly
- **`KybStatus`, `PhoneLineType`, `AddressVerifiedMethod` promoted String → enum** — closed vocabularies that gate risk decisions, so an unexpected value should be a migration, not a row. `idDocumentType` and `eventType` stay String: those sets genuinely grow per country, per KYC provider, per event

Also: `onDelete: Restrict` everywhere, explicitly. An audit trail that disappears
with its subject is not an audit trail — a payment with evidence cannot be deleted.
`EvidenceRecord` deliberately has no `updatedAt`: a record that can be revised is
not evidence, so corrections are new records.

Enum duplication between `schema.prisma` and `@cp/shared-types` is only safe if
checked — a test parses the schema and asserts parity on all 10.

### D26 · Money is a decimal string on the wire, and a payment names an exact wallet version — `build`

- amounts never cross the wire as JS numbers: doubles cannot represent 0.1 exactly and these values move funds irreversibly
- `AmountString` caps at 18 decimal places — matching `Decimal(38,18)` (D25), so the wire cannot accept precision the column would silently truncate
- rejects zero and negatives at the schema, not in a handler
- **`CreatePaymentRequest` requires `vendorWalletId`, not just `vendorId`** — wallets are versioned (D01), so a payment must name the version it was authorised against; resolving "the vendor's current wallet" at send time means a rotation between decision and send silently redirects the money
- format rules (address, bytes32, signature, amount) live in `primitives.ts` and are written once — a regex copied into six route schemas eventually disagrees with itself, and the place it disagrees is the place that accepts a malformed payout address

### D27 · Evidence payloads are a closed union; API responses are whitelists — `build`

- `EvidencePayload` is discriminated on `eventType`, so each event's `data` is checked against its own shape
- a loose `Record<string, unknown>` would accept anything — including the PII that design principle 2 exists to keep out of the chain
- every declared field is an identifier, enum, score, or hash. That is the test to apply before adding one
- Zod strips undeclared keys, so a field that leaks into a payload does not survive parsing — verified by test, not by review
- same shape for read models: `VendorSummary` is a whitelist projection, so widening the type is the only way PII reaches a client, and that is a visible edit

### D28 · One XML parser for data and for signature; integrity and trust reported separately — `build`

- data extraction and signature verification both go through `@xmldom/xmldom`
- using a different parser for each is a real vulnerability class: the verifier checks one interpretation of the bytes while the application reads another, and a crafted document makes the two disagree
- the signature check answers **two** questions and keeps them apart:
  - **integrity** — does the signature verify against the certificate embedded in the document? proves the bytes are unaltered, proves nothing about who signed
  - **trust** — is that certificate one we accept? a self-signed cert produces a perfectly valid signature over a forged document
- only `integrity && trust` may set `xmlSignatureVerified`
- **honest limit**: DigiLocker embeds only the signing certificate, not the chain. Full PKI path validation to an Indian CA root needs those roots supplied out of band. Until then trust means subject matching plus optional fingerprint pinning, and the code says so rather than implying more
- signer is `O=DIGITAL INDIA CORPORATION` (DigiLocker signs on the issuer's behalf), not UIDAI directly — verified against the live documents
- exclusive C14N normalises attribute syntax before digesting, so reformatting whitespace inside a tag is **not** tampering. Both behaviours are pinned by test, because a test that treated it as tampering would assert the wrong property

### D29 · DigiLocker naive timestamps are parsed as IST, explicitly — `build`

- `KycRes@ts` carries `+05:30`; `KycRes@ttl` omits the offset and is the same wall clock a year on
- `new Date("2027-09-03T04:10:04")` resolves against the **server's** timezone → the same document expires on different days in Mumbai and Frankfurt
- caught by the fixture replay: the UTC calendar day came back a day early
- the ttl is a re-verification deadline (D06), so this is a correctness bug in when CONFIRMED lapses, not a formatting nit
- tests compare the instant, never a UTC calendar day — comparing days would bake the bug back in

### D30 · Encrypted blobs live in Postgres, and the "ref" is a real foreign key — `build`

- §3 calls `photoEncryptedRef` / `rawContextEncryptedRef` pointers but never says to what
- MVP choice: ciphertext in a `bytea` column on `EncryptedBlob`, ref = that row's id
- one datastore, one backup story, one access-control surface; payloads are small (a UIDAI portrait is a few KB)
- the ref is a **foreign key with `onDelete: Restrict`**, not a loose string — a pointer cannot dangle, and a blob cannot be deleted out from under the record citing it
- AES-256-GCM, fresh IV per blob: authenticated, so a tampered blob fails to decrypt rather than returning plausible garbage, and identical plaintexts never produce identical ciphertext (deterministic ciphertext would leak which vendors share an address)
- HMAC and encryption are different tools for different jobs: HMAC for values only ever **matched** (PAN, tax id), AES for values that must be **read back** (portrait, address, DOB). Mixing them is the usual mistake
- revisit if blobs ever get large or numerous — the swap is one module

### D31 · Relative config paths resolve against the repo root, never cwd — `build`

- caught live: `DIGILOCKER_FIXTURE_DIR=./fixtures/digilocker` resolved under `apps/api`, not the repo root, and the flow 404'd
- the process starts in `apps/api` under pnpm, at the repo root under some editors, elsewhere again in a container — a cwd-relative path silently means three different directories
- `config.repoRoot` is the directory the `.env` was found in; relative paths resolve against it
- same class of bug as the Prisma CLI not walking up for `.env`

**Live DigiLocker client — one unverified assumption.** Only the `/authenticate`
headers were captured on 2026-09-08. The authenticated-request headers follow the
aggregator's documented convention (bearer token plus api key) and are marked
UNVERIFIED in the code. A 401 on the first live run is far more likely to be the
header shape than a bad credential.

### D32 · No hardware wallet in scope; the boundary stays, the custody claim shrinks — `build`

**What is unchanged.** The security property was never the device — it is the
boundary (D12): `apps/api` writes proposals and cannot sign, `approval-bridge`
is a separate process with a separate role secret, and an `agent` token fails
signature verification on `/approvals/*`. A7 builds exactly as planned.

**What genuinely weakens.** Without hardware, the signing key is software on the
approver's machine:

- still true — *autonomous code cannot move money* (role separation + a human confirmation step)
- no longer true — *the key cannot be exfiltrated from the approver's machine*

State it as "human-gated approval with a separate signing process,
hardware-ready". Do not imply hardware custody. Overclaiming here is worse than
the missing device.

**Transport values** — `mock` | `local` | `usb` | `speculos`, chosen by
`WALLET_CLI_TRANSPORT`:

- `mock` (default) — device-style confirmation prompt, synthetic tx hash, no key anywhere. Tests and CI run on this
- `local` — encrypted keystore on the approver's machine, password prompted at approve time, real Sepolia broadcast. Gives the demo a genuine txHash and explorer link, and keeps a visible human-in-the-loop moment
- `usb` / `speculos` — declared, unimplemented, 501 (D21). A device later is a config change, not a rewrite

**Key storage**: a password-protected keystore file, never `.env`. A private key
sitting beside live Sandbox credentials is one screenshot away from disclosure.

### D33 · Two EIP-712 signatures, because they prove different things — `build`

- **`WalletControlProof`** — "I hold the key to this address." A thief holding a stolen key signs this correctly, so it proves custody and nothing else, and it does **not** advance wallet status on its own
- **`IdentityBinding`** — "I am the person behind this verified identity and this wallet is mine." Signs over the onboarding nonce, the DigiLocker user id, the wallet address and **both document hashes**
- signing over the doc hashes means the attestation cannot be replayed against a different onboarding attempt, a different identity, or a different set of documents
- `chainId` is in the domain, so a signature made for one chain will not verify on another
- the claimed address is an **input** to verification, never trusted: the signature recovers to it or the call fails
- `verifyTypedData` (viem) also accepts ERC-1271 smart-contract accounts, which raw ecrecover would reject
- **schema consequence**: `aadhaarDocHash` / `panDocHash` are persisted (not in §3). The raw documents are deliberately not retained, so without these the attestation payload cannot be rebuilt and the signature becomes unverifiable the moment the session ends

### D34 · CONFIRMED needs three independent gates, and the callback fails closed — `build`

Wallet status advances to CONFIRMED only when all three hold:

1. **control proof** — the signer holds the key
2. **identity binding** — the verified identity claims that key, under the same nonce
3. **callback** — a human reached the payee on an independent channel

**Independent means independent of the submission being confirmed.** Never the
request body, never a field the same actor just wrote:

- BUSINESS → `registryVerifiedContact`, from a registry lookup
- INDIVIDUAL → the **DigiLocker-verified mobile**. No business registry exists for a freelancer, and this number is attested by the identity flow rather than supplied alongside the wallet
- a contact recorded *after* the wallet was submitted is rejected — that is the account-takeover path

**Fails closed.** No independent contact on file means the wallet cannot be
confirmed. "Nothing on file" must never mean "skip the check" — that is exactly
the demo shortcut that removes the control.

**The rejection does not name the expected contact.** Echoing it would turn the
control into a single guess.

Phone comparison ignores separators only: a registry writes "+91 22 5550-0100"
and an operator types "+912255500100". Digits still must match exactly.

### D35 · Decision precedence is policy, and matching is fuzzy on names but exact on addresses — `build`

**Order in `decide()` is deliberate**, hard blocks before soft, first match wins:

1. `sanctionsHit` → DO_NOT_SEND
2. wallet not CONFIRMED → DO_NOT_SEND
3. TIER0 → DO_NOT_SEND
4. match failed → **REVERIFY**, not DO_NOT_SEND — a name mismatch is usually a typo or a trading name, and needs a person rather than a permanent refusal
5. amount over the tier ceiling → REVERIFY (inclusive: exactly at the limit passes)
6. first payment to this address → SEND_TEST_AMOUNT
7. → SAFE_TO_SEND

The most severe finding wins because it is what lands in the evidence chain and
gets read back in a dispute. A sanctions hit masked by an unrelated tier problem
would be a materially wrong record. Tested explicitly.

**`isNewOrChangedAddress` counts only SENT / CONFIRMED_ON_CHAIN history.** A
DRAFT payment to the same address proves nothing — the attacker could have
created it.

**Matching treats the two fields completely differently:**

- **address, network, token contract — exact, and checked FIRST.** No name score compensates for an address the vendor never registered; that is the misdirection this product exists to prevent
- **legal name — fuzzy, Dice over tokens with corporate suffixes stripped.** "MERIDIAN COMPONENTS PRIVATE LIMITED" and "Meridian Components Pvt Ltd" are the same company, and a system that cannot say so is one nobody uses

That fuzziness is the **opposite** of `identity/normalise/name.ts`, which is
exact — and the difference is what the output gates. Identity comparison returns
a boolean that blocks money; matching returns a score a human reads, with
REVERIFY as the escape hatch. Suffix-only names ("Private Limited" vs "Ltd")
score 0, never 1, since nothing distinguishing remains.

The score is reported even when it fails the threshold: a reviewer judging
"typo" against "wrong company" needs the number.

### D36 · The chain stores its payloads, and verification recomputes rather than compares — `build`

**Schema deviation: `EvidenceRecord.payload`.** §3 stores only hashes. Two
problems with that:

- verifying a chain means **recomputing** each hash from its content. With only hashes you can check that links point at each other, not that any record still says what it said
- evidence with no content cannot be read back in a dispute, which is the entire purpose

Storing the payload is safe precisely because of D27: the payload union is
closed and PII-free by construction, and a test asserts no vendor name, Aadhaar
digits or phone number appears in any stored payload.

**Canonicalisation rejects rather than coerces.** `undefined` disappears, `NaN`
and `Infinity` become `null`, a bigint loses precision — each would hash
something other than what the caller passed. When the output is evidence,
failing loudly is the only safe behaviour. Object keys sort by code unit (not
`localeCompare`, which is locale-dependent); array order is preserved because it
is meaningful.

**Verification reports the first break with an index**, and distinguishes
*content* tampering (payload no longer hashes to its stored hash) from *linkage*
tampering (insertion, removal, reordering). "The chain is broken" is not
actionable; "record 2 of 6 was altered" is.

**Two records per decision, in causal order** — `vendor_match` then `decision`.
One combined record would lose the difference between "the match was wrong" and
"the policy was wrong".

**The access audit is appended after the response is built**, so a reader sees
the chain as of their read rather than one containing the record describing that
same read. It is also the only append not tied to a state change, so it retries
on the fork constraint when two readers race for the tip.

**Known gap**: evidence is payment-scoped — `EvidenceRecord` requires a
`paymentRequestId`. Vendor-level events (identity verified, wallet confirmed,
KYB changed) have no chain today. §4.8 does not address it; it needs a nullable
payment reference or a separate vendor chain.

### D37 · Queuing is a separate fact from being permitted, and confirmation is not a keypress — `build`

**`Proposal` is its own model** (deviation from §3). §4.3's `PendingProposal`
contract carries its own id and `proposedAt`, which implies a record rather than
a view over `PaymentRequest`. It also keeps two different facts apart:

- `status = AWAITING_APPROVAL` — the decision engine permits this
- a Proposal row — an agent actually queued it for a human

Only the second belongs in the approver's queue. `propose` refuses anything not
AWAITING_APPROVAL, so a DO_NOT_SEND or REVERIFY payment can never reach an
approver's terminal — that is how a human ends up rubber-stamping something the
engine already refused.

**Consumed proposals leave the queue, and a second report is 409.** Reporting
twice would write two ApprovalEvents and two `send` records for one payment.

**`requireAnyRole` for the queue.** Both a human approver and the bridge daemon
have a genuine claim to `/approvals/*`. It tries each role in turn against that
role's own secret — it does not loosen verification. An agent token still fails
every one, at the signature check.

**The operator types the amount back.** A y/n prompt is answered reflexively;
re-typing the amount forces the one number that matters through their attention.
This is what a hardware device's screen was providing, and with no device in
scope (D32) the prompt has to carry it.

**`watch` polls but never approves.** Polling is unattended, approving is not.
An auto-approving daemon would recreate exactly what this architecture removes.

**The mock transport always reports `broadcast: false`**, and the CLI prints it
every time. A plausible-looking synthetic hash is how a demo accidentally claims
a transaction that never happened.

**Keystore decryption checks the MAC.** Implemented directly rather than adding
a wallet library for one function. Without the MAC check a wrong password
returns plausible-looking bytes that would then be used as a signing key.

### D38 · The registry hook fails closed and is not public — `build`

**Direction matters**: the ATS Control List calls INTO this endpoint. Nothing
here calls Hedera, which is why it is core work rather than Track B (D20), and
why it makes this platform's KYC the compliance backend the token actually
consults rather than a badge beside it.

- **only `CONFIRMED` answers yes.** Unknown, `PENDING_VERIFICATION` and `REVOKED` all return `verified: false`. This gates transfers, so anything short of a positive confirmation must be a no
- **case-insensitive matching.** EVM addresses are case-insensitive; a checksummed address from the chain and a lowercased one in the database are the same address. An exact match would answer "not verified" for a confirmed wallet and block a legitimate transfer
- **most recent confirmed version wins**, so an address re-registered after revocation resolves correctly (D01's versioning)
- **authenticated**, despite being machine-to-machine. An open endpoint answering "is this a confirmed vendor address?" lets anyone enumerate the platform's business relationships

**Open**: any role is currently accepted, because the caller is a
deployment-side relayer. A dedicated `registry` role with its own secret is the
right shape before this is exposed to a third party — least privilege, and it
would let the hook be revoked without rotating agent or approver credentials.

### D39 · Hedera ATS is the primary deliverable; everything else is sized to protect it — `build`

- the ATS track is the highest-priority bounty, and its four qualification bars are pass/fail — partial credit is worth nothing
- **B1 moves ahead of A9/A10/A11.** Track A is the credibility behind the submission, not the submission
- **A9 shrinks to two screens** — approval and evidence viewer. Onboarding forms and dashboards demo fine through Swagger; a half-built dashboard costs B1 time and adds nothing
- **B4 (World ID) and B5 (CRE) demoted** below B1. Both are access-gated, and the fallback matcher already tells the vendor-match story
- **B2 (HCS anchoring) stays** — cheap, on-thesis, and independent of B1
- reversing an earlier call: I recommended cutting B1 to fund the HTLC. That was wrong — B1 is the bounty's first qualification bar, and HCS does not substitute for tokenization

### D40 · The ATS integration is on-chain KYC via verifiable credentials, not an HTTP registry — `build`

**§4.5's code does not exist.** Verified against the installed SDK 1.17.0:

- there is no `ATSFactory` or `deployBond(...)`. Issuance is `Bond.create(CreateBondRequest)`, a singleton; `Factory` only exposes `getRegulationDetails`
- there is no `complianceConfig.identityRegistryUrl`. Compliance is configured with flags and **on-chain contract ids**: `isWhiteList`, `internalKycActivated`, `externalKycListsIds`, `externalControlListsIds`, `complianceId`, `identityRegistryId`
- `addExternalKycList` takes `externalKycListAddress` — a contract address. **A token cannot call our HTTPS endpoint**, so the hook as described could never have worked

**The chosen path**: ATS internal KYC, granted with a verifiable credential.

```
SsiManagement.addIssuer(...)                          register the platform as issuer
Bond.create({ internalKycActivated: true, ... })      the token enforces KYC itself
Kyc.grantKyc({ securityId, targetId, vcBase64 })      on CONFIRMED
Kyc.revokeKyc(...)                                    on revocation
```

Chosen over deploying our own external-KYC-list contract because it is less work,
and because the credential is a genuine fit: the DigiLocker four checks plus the
nonce-bound EIP-712 attestation are exactly what a VC should assert. Most
submissions will hardcode an allowlist; this one has a real verification pipeline
behind the grant.

**A8 is not wasted.** It stops being "the integration" and becomes the source of
truth that drives `grantKyc`/`revokeKyc` on chain.

**Lifecycle is real, not decorative**: `setCoupon`, `getAllCoupons`,
`updateMaturityDate`, `redeemAtMaturityByPartition`, `addProceedRecipient`.
That is what "real lifecycle management over a token with a name on it" asks for.

### D41 · HTLC is the settlement leg of the ATS lifecycle, not a parallel feature — `build`

- attaches at `redeemAtMaturityByPartition`: maturity settlement pays out through a hashed timelock
- the payee claims by revealing the preimage, which **is** the recipient acknowledgment — non-repudiation of receipt without a trusted third party, which is the paper sitting in this repo
- unclaimed funds refund on timeout, so a misdirect becomes recoverable. "Irrecoverable" stops being the honest limitation in the pitch
- **deployed on Hedera** (HSCS is EVM-compatible), not Sepolia: one chain, one explorer, one narrative
- **per-payment `settlementMode: direct | htlc`**, never a replacement. A plain transfer stays the default, so a vendor who will not claim still gets paid — and the demo shows both
- scope is deliberately minimal: `lock` / `claim` / `refund`. No partial claims, no multi-hop, no cross-chain
- **built, and one clause above is wrong** — the escrow wraps the payout leg, not `redeemAtMaturityByPartition`, which burns a holding and has no counterparty to claim. See D50 for that and the five other calls the build forced

### D42 · Split the ATS integration: browser SDK for issuance, headless ABI for KYC grants — `build`

**The SDK is client-facing.** Its README says so, `SupportedWallets` is
`METAMASK | HWALLETCONNECT | DFNS | FIREBLOCKS | AWSKMS`, and `connect` returns
wallet pairing strings and topics. There is **no headless private-key signer** —
so a plain Node deploy script driven by `HEDERA_OPERATOR_KEY` cannot use the SDK.

**But `@hashgraph/asset-tokenization-contracts` ships Solidity sources, Hardhat
artifacts and typechain types**, so the contracts can be called directly. The
bounty allows "SDK, contracts, web application, or a combination".

So the integration splits along a line that matches what each part actually is:

| Concern | How | Why |
|---|---|---|
| Issuance + configuration | Browser + SDK, MetaMask/HashPack on Hedera testnet | one-time, human-driven, and it is what the demo video films; the SDK handles the diamond/resolver plumbing |
| KYC grant / revoke | Headless, ABI + viem from `apps/api` | continuous and automatic — the platform grants KYC the moment a wallet reaches CONFIRMED. This is inherently server-side, and it is the differentiator |

**Consequence**: a browser wallet IS needed after all, reversing what I said
earlier about Hedera needing only an operator account. MetaMask on Hedera testnet
(via the JSON-RPC relay) or HashPack. Not hardware, so D32 stands.

**Consequence**: the shrunk A9 web app is no longer optional polish — the
issuance screen is part of B1's critical path.

**The on-chain call is a credential reference, not a credential**:

```
grantKyc(address account, string vcId, uint256 validFrom, uint256 validTo, address issuer)
revokeKyc(address account)
```

The credential itself stays off-chain, which suits design principle 2 — no PII
on chain, only an identifier and a validity window. `validTo` maps naturally to
`aadhaarKycTtl`: D06's time-bounded verification becomes an on-chain expiry, so
a stale identity stops being transferable without anyone remembering to act.

### D43 · `z.string().url()` is unsafe inside a CRE workflow config schema — `build`

- reproduced against three different valid URLs (`http://localhost:3000`,
  `https://example.com`, and a re-run of the same value) — config hash changed
  each time, confirming the engine was genuinely re-validating fresh input,
  not caching a stale rejection. All three failed identically:
  `{ validation: "url", code: "invalid_string", path: ["vendorLookupUrl"] }`
- the same schema, same value, passes `safeParse` cleanly in plain Node —
  the failure is specific to CRE's execution environment, not the value or
  the schema shape
- likely cause, not fully confirmed: `@chainlink/cre-sdk` ships
  `@chainlink/cre-sdk-javy-plugin` — Javy is a QuickJS-based WASM JS engine —
  and Zod 3.x's `.url()` validator calls the native `URL` constructor, which
  QuickJS is not guaranteed to implement or implement completely
- fix: use a plain `z.string()` for URL-shaped config fields inside a CRE
  workflow's `configSchema`. Validate the format at the point the value is
  authored (a deploy script, CI) instead of inside the workflow, where a
  failure surfaces as an opaque engine error rather than a clear message
- consequence for every future CRE workflow in this repo, not just
  vendor-match: audit any `configSchema` for other native-API-dependent Zod
  validators before assuming they work — `.email()`, `.uuid()`, `.datetime()`
  are regex-based in Zod 3.x and likely fine, but this was not exhaustively
  checked and should not be assumed either
- found by: getting `cre init` past what first looked like an unrelated hang
  (it was `--deployment-registry` needing to be explicit — the CLI validates
  `--project-name`/`--workflow-name` upfront in `--non-interactive` mode but
  silently renders an interactive picker for this one instead of the same
  fast, clear error) to obtain a real reference implementation
  (`cre init --template=hello-confidential-workflows-ts`), then running an
  actual `cre workflow simulate` against this project rather than stopping at
  a clean `tsc --noEmit`. The typecheck alone would never have caught this —
  it is a runtime-only failure in a specific execution environment. The same
  reference also caught two further bugs the typecheck missed: outbound
  requests need `multiHeaders` (`Record<string, { values: string[] }>`), not
  the deprecated `headers` map; and the SDK ships `ok()`/`json()` response
  helpers meant to replace hand-rolled status/body parsing — both fixed in
  `packages/cre-workflows/src/cre/workflow.ts`

### D44 · A green simulation that exercised one branch is not a working integration — `build`

The workflow simulated successfully, returned `VENDOR_NOT_FOUND`, and that was
reported as working end to end. It was not. Two things were wrong and one
masked the other:

- **only the early-return failure branch ran.** The wallet check,
  `nameSimilarity` and the threshold comparison — the logic the workflow
  exists for — never executed
- **`/internal/vendor-lookup/:vendorId` did not exist.** It was invented while
  writing `workflow.ts`; the only internal route was
  `/internal/identity-registry/:address`

`vendorLookupUrl` pointed at `example.com`, which 404s on every path. So
"correctly handled a missing vendor" and "called a route nobody built" produced
an identical result, and the passing verdict was right by coincidence.

**The rule this establishes**: a simulation proves a branch, not an
integration. Enumerate the result space and drive every branch, or state
plainly which ones have never run. The five-branch matrix now in
[progress.md](./progress.md) B5 is what "working" means for this workflow.

**Consequence for the endpoint**: it now exists and returns only `legalName`
plus CONFIRMED wallets. Deliberately narrow — the enclave compares a name and
an address, so DOB, PAN, address and documents have no business crossing into
an HTTP response (design principle 2, D27). CONFIRMED-only matches the
registry hook's fail-closed rule (D38): a pending or revoked wallet must not
satisfy a match.

### D45 · The CRE contract suite cannot run against the enclave, and stubbing it would prove nothing — `build`

D09 says both `VendorMatcher` implementations pass one shared suite. For
`CreVendorMatcher` that stays **unmet, honestly** rather than faked:

- the adapter is a thin HTTP client; the matching logic runs in the enclave
- stubbing `fetch` and running the contract against it tests the stub, not the
  workflow — a green result would assert nothing about the deployed behaviour
- so the shared contract runs against the fallback only, and the enclave is
  verified separately by driving all five branches through
  `cre workflow simulate` against a live API

What `cre-adapter.test.ts` does cover is the adapter's own real behaviour,
which is not blocked on anything: that it signs, sends the input, and
**throws on 401/504 rather than returning a negative verdict** — so "we could
not check" never reaches the decision engine wearing the face of "we checked
and it failed".

Closing this properly needs a deployed trigger, which needs deploy access (§8).

**Update — deploy access came through, and deploying answered the open
question in D45 and closed the gap in D44.** The signing scheme is not a
mystery and never needed guessing at: the first deploy registered but failed
to activate, with

> HTTP trigger requires at least one authorized key to sign JSON-RPC requests.
> Add AuthorizedKeys to your http.Trigger configuration with ECDSA EVM public
> keys (0x-prefixed hex strings)

So `authorizedKeys: []` was not merely insecure, it was **structurally
invalid** — CRE refuses to activate an open trigger. The platform enforces
what this repo had written down as a "must fix before production" item, which
is the best possible outcome: the insecure configuration was never deployable.

Shape (from `trigger_pb.d.ts`): `{ type: "KEY_TYPE_ECDSA_EVM", publicKey }`.
Keys are public, so they live in `config.*.json`, not Vault. The config schema
requires `.min(1)` so the failure surfaces at simulate time rather than after
an upload.

Deployed: workflow ID `0091821287201a7687f7453930a6c670b64bcfbd0a9efb32fb3f923925f4b4b7`,
private (Chainlink-hosted) registry, DON family `zone-a`, status ACTIVE.
`private` was chosen over `onchain:ethereum-mainnet` because it needs neither
gas nor a wallet key — right for a demo, and the registry is a one-line change
in `workflow.yaml` if that stops being true.

### D46 · Row Level Security on every public table — the auth layer was not the only door — `build`

Prompted by a Supabase linter warning about `_prisma_migrations`. The warning
was the least of it. Verified against the live project using only
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — a key whose whole purpose is to be
shipped to browsers:

- **read**: every table returned rows. `Vendor`, `VendorWallet`,
  `PaymentRequest` all disclosed real data
- **write**: `PATCH` and `DELETE` were both *permitted*. A
  `PATCH VendorWallet {status:"CONFIRMED"}` would have confirmed an arbitrary
  wallet, and `DELETE EvidenceRecord` would have destroyed the audit chain

**Why this mattered more than a normal misconfiguration**: every access
decision in this file assumes Prisma-over-direct-Postgres is the only path to
the data. PostgREST is a second, parallel door that answers to none of it — not
the agent/approver split (D12), not the three confirmation gates (D34), not the
callback control (D05), not the audited evidence read (D18). The application's
controls were sound and simply bypassable.

**Fix**: `ENABLE ROW LEVEL SECURITY` on all 11 public tables, no policies —
deny-all for the `anon`/`authenticated` roles PostgREST uses. Deliberately
`ENABLE` and not `FORCE`: the table owner stays exempt, so Prisma is untouched.
No code changed; 189 tests confirm it.

**Verified by re-attack, not by assumption.** Reads now return `[]`. For writes
a zero-row result is ambiguous — it looks the same whether RLS blocked the row
or the filter matched nothing — so the check was a real state change
(`CONFIRMED → REVOKED`) against a row known to exist, read back through Prisma:
unchanged.

**Consequence, and the general lesson**: a hosted Postgres is not just
Postgres. Anything bundling an auto-exposed API over the same tables adds an
entry point the application layer has no visibility into, and it must be closed
explicitly at provisioning, not discovered by a linter. Still open: rotate the
exposed key, and decide whether the REST layer is wanted at all — if not,
restricting the exposed schema removes the door instead of locking it.

### D47 · Confidential Workflows is a separate entitlement — the deployment was live and every execution failed — `build`

The TEE workflow deployed ACTIVE and the gateway answered every invocation with
HTTP 200 `"status":"ACCEPTED"`. All three executions had already failed:

```
Status:  FAILURE   (0ms)
Top-Level Errors:
  - confidential-workflows capability is disabled by settings:
    PerWorkflow.ConfidentialWorkflows.Enabled limited for workflow[0091...]:
    not allowed
```

`cre whoami` says `Deploy Access: Enabled`, and that is a *different* grant from
`confidential-workflows`, which is authorized per workflow and is not reported
by `whoami` at all. Nothing in the code was wrong — 0ms means the handler was
never entered.

**The trap, which is D44's lesson one layer further out**: `ACCEPTED` is the
gateway confirming it queued the request, not the DON confirming it ran the
workflow. Reading only the invocation response, this looked like a working
deployment. Three green 200s sat directly on top of three FAILUREs. Any check
that stops at the synchronous response cannot see execution failure, so
`scripts/invoke-workflow.mjs` now polls each execution to a terminal state and
reports nothing it did not read back off a finished execution.

**Fix**: the workflow registers one of two handlers from the same code path,
chosen by a required `confidential` config field —

| `confidential` | handler | comparison runs |
|---|---|---|
| `true` | `cre.handlerInTee` | inside an AWS Nitro enclave |
| `false` | `cre.handler` | on DON nodes under consensus |

`false` is deployed now, so the entire surrounding path is proven against the
real network while the entitlement is pending; `true` is the intended mode and
becomes a one-field change the moment it is granted. The field is required
rather than defaulted so a deployment's confidentiality is legible from the
config file it shipped with.

**This is not a free swap.** DON mode is genuinely less confidential: the vendor
record is visible to each node that fetches it, where the enclave exposes only
the verdict. That is the whole cost of running without the entitlement, and the
reason `config.production.json` stays `confidential: true`.

The two modes are also structurally different, not a renamed call. On a plain
`Runtime` the HTTP capability takes a *function plus a consensus aggregation*
rather than a request object, because every node fetches independently and the
results must be reconciled (`client_sdk_gen.d.ts`, third `sendRequest`
overload). Each node therefore fetches *and* evaluates and returns a finished
verdict, reconciled with `consensusIdenticalAggregation` — correct strictness
here, since a vendor's registered wallets are not a fluctuating quantity like a
price, so nodes disagreeing means something is wrong and no verdict should
issue.

Because a third copy of the match rule was now one edit away from existing, the
rule itself moved into `src/matching.ts` as one pure `evaluateMatch()` used by
the fallback, the TEE handler and the DON handler alike. D09's equivalence
guarantee previously rested on a shared test suite noticing drift; a shared
test only catches drift on cases it happens to cover, and shared code cannot
drift at all.

**What is proven on the deployed workflow** (ID
`00c06f9fc379b76606922ea574c412dbad4e77cfc25297c4d8d8d25a04db9ab2`), all four
cases SUCCESS, corroborated by the ngrok request inspector:

- signed-JWT auth, gateway routing, DON scheduling, Vault secret retrieval,
  and the authenticated outbound lookup — the tunnel logged `200`s for the
  known vendor, several per execution, one per observing node
- `consensus@1.0.0-alpha` reached agreement in every execution
- the `VENDOR_NOT_FOUND` branch: the unknown vendor logged `404`s and the
  execution still SUCCEEDED, so a 404 is being turned into a verdict rather
  than an error — the distinction D44 was written about

**What is not proven there, stated precisely**: `MATCHED` vs
`WALLET_NOT_ON_FILE` vs `NAME_BELOW_THRESHOLD` all receive an identical `200`
and differ only in the pure comparison, and the deployed workflow's return
value cannot currently be read back (D48). Those three branches are covered by
the unit suite and by local simulation, not by the deployed instance.

Incidental: the gateway rate-limits back-to-back invocations (`-32002`), the
execution id it returns is `0x`-prefixed while `cre execution status` rejects
that exact string, and `--target` takes the full settings key
(`staging-settings`, not `staging`). One execution also logged a non-fatal
`InsufficientObservations` and still reached SUCCESS.

### D48 · The HTTP trigger is fire-and-forget, so the verdict needs a return path — `architecture`

`workflows.execute` returns `{workflow_execution_id, status:"ACCEPTED"}` and
nothing else. There is no documented JSON-RPC method to fetch an execution's
return value, and `cre execution status/events/logs` report timing, capability
calls and errors but not the handler's result. The documentation's only
suggestion for seeing a result is the CRE UI.

**Consequence for the product**: a CRE workflow cannot be called as a
synchronous "is this payee verified?" RPC from `apps/api`. The decision engine
needs the verdict to gate a payment, and today the verdict has nowhere to go —
this is a real gap in §4.4, not a deployment detail.

**Recommended fix, not yet built**: give the trigger input a `requestId` and
have the handler POST the verdict back to an internal callback endpoint, with
the API correlating and the payment flow awaiting that record. This suits the
confidential design rather than fighting it — the callback carries only the
verdict, which is exactly the one value that is supposed to leave the enclave,
and it works identically in both handler modes.

### D48a · Resolved — the callback path, and what it proved that nothing else could — `build`

Built as recommended, and it closed more than the gap it was written for.

**Shape.** The API creates a `VendorMatchRequest` row, invokes the trigger with
that `requestId`, the workflow POSTs its verdict to
`/internal/vendor-match-result`, and `CreVendorMatcher` awaits the row.

The row is created **before** the invocation, and that ordering is the security
control, not bookkeeping: the callback endpoint rejects any `requestId` it has
never issued, so the endpoint cannot be used to inject a verdict for a match
nobody asked for. A test asserts the ordering directly, because a later
refactor that moved the write after the invocation would still pass every
functional test while quietly removing the check.

**Idempotency is structural, not a nicety.** In DON mode the HTTP capability is
only reachable from inside the node function, so every observing node posts the
same verdict — the ngrok inspector shows five lookups per execution and five
callbacks follow. First write wins; the rest return `ALREADY_RECORDED`. A
conflicting late verdict cannot overwrite a recorded one.

**Failure is carried separately from a negative verdict.** A workflow that could
not check lands the row in `FAILED` with a null `match`, and the matcher throws
rather than returning `{match: false}`. `VendorMatchTimeoutError` and
`VendorMatchFailedError` are distinct types, and a `COMPLETED` row with a null
verdict is refused outright instead of being read as a mismatch — D44's rule
applied at every layer this exchange added.

**What it proved.** D47 had to state that `MATCHED`, `WALLET_NOT_ON_FILE` and
`NAME_BELOW_THRESHOLD` were *not* individually verified on the deployed
workflow: all three receive an identical `200` and differ only in the pure
comparison, and no verdict could be read back. `SUCCESS` could not distinguish
them — a matcher that always answered `MATCHED` would have looked identical
across all four cases.

With the callback, `apps/api/scripts/cre-e2e.ts` drives the real container, the
real matcher, the real gateway and the real database against the deployed
workflow, and **all four verdicts came back correct**:

```
✓ MATCHED              -> MATCHED              match=true  score=1
✓ WALLET_NOT_ON_FILE   -> WALLET_NOT_ON_FILE   match=false score=0
✓ NAME_BELOW_THRESHOLD -> NAME_BELOW_THRESHOLD match=false score=0
✓ VENDOR_NOT_FOUND     -> VENDOR_NOT_FOUND     match=false score=0
```

That also closes D45: the CRE implementation is now exercised against the same
four branches as the fallback, against a live deployment rather than a stub.

**Two things the build itself taught, both invisible from the docs:**

1. `body` on an outbound request is a base64 **string**, not raw JSON and not a
   `Uint8Array` — these request literals match the SDK's `RequestJson` shape,
   which is also why partial fields typecheck. `btoa`/`Buffer` are not
   guaranteed in Javy/QuickJS (D43 already proved that assuming a standard
   global fails only at deploy time), so the encoder is written by hand.
2. The caller-side code could not live in `packages/cre-workflows` at all. The
   CRE SDK's `restricted-node-modules` types make node builtins `never` for
   every file in that package's tsconfig, so merely *having* a file that
   imports `node:crypto` broke the WASM build with "Type 'never' has no call
   signatures" — even though nothing the workflow imports referenced it. The
   gateway client and matcher now live in `apps/api/src/modules/vendorMatch/`,
   which is where the caller belongs anyway.

**Also fixed while here**: D46 was applied by hand against the live database,
so a fresh provision came up **without** RLS — and `VendorMatchRequest` would
have been created wide open. RLS is now a migration that loops over
`pg_tables` rather than naming tables, so a table added later cannot miss it.
Re-verified with the publishable key: the new table reads `[]`.

**Still open**: `VENDOR_MATCHER` stays `fallback` in `.env` because the test
suite would otherwise drive 200+ tests through the live gateway and the ngrok
tunnel. The swap is a one-word change and is proven by `pnpm --filter @cp/api
cre:e2e`; the deployment remains pinned to the tunnel URL, and the Vault secret
is still a ~12h agent JWT.

### D49 · Selfie Check is enabled — proven by running it, not by reading the portal — `build`

The Developer Portal MCP exposes no feature-flag field: `get_app_config` returns
registration status, store metadata and actions, and nothing about which
credentials an app may request. The docs are explicit that "a valid app or
action does not imply Selfie Check access", so the config told us nothing either
way. The only conclusive test was to request the credential and read what came
back.

It came back enabled:

```
"identifier": "selfie"          — not "orb", not "proof_of_human"
"success": true
"message": "Proof verified successfully"
```

`protocol_version: "3.0"` is correct, not a fallback: Selfie Check is backed by a
World ID 3.0 proof, which is why `allow_legacy_proofs: true` is mandatory. A v4
integration that omits it cannot satisfy the request at all.

**Two findings from the returned payload that change the design:**

**1. An empty signal binds the proof to nothing.** The result carried
`signal_hash: 0x00c5d246…`, the hash of the empty string. That proof attests
"a human completed a selfie for this action" — not "this human approved *this*
payment". As an approval gate that is decorative. The signal must carry the
proposal id.

**2. World's documented uniqueness rule is wrong for this product.** The docs
prescribe `UNIQUE (nullifier, action)`. The nullifier is RP- and action-scoped
and is *stable per person*, so with our static action that constraint means
**each human may approve exactly one payment ever** — the second approval is
rejected as a replay. Adopting the documented rule unmodified would have shipped
an approval gate that bricks itself after one use, and the failure would look
like a security feature working correctly.

**Decision**: keep the action static and scope uniqueness to the signal —
`UNIQUE (nullifier, action, signal)` with `signal = proposalId`. The same
approver can approve many payments; nobody can approve the same one twice. The
signal is inside the verified proof, so it cannot be forged by the client. The
alternative — a dynamic `approve-payment-<id>` action — is rejected because each
action must be pre-registered in the Portal, which does not survive contact with
real payment volume.

**Assurance, stated honestly**: Selfie Check is *medium* assurance and explicitly
not one-person-one-account. It proves a live human is present, not *which*
human, and lapses after 90 days of inactivity. It therefore belongs on the
approver as anti-automation friction — it is NOT beneficiary identity, which
rests on DigiLocker plus the EIP-712 wallet-control signature (§4.7, D02). The
submission must not claim otherwise.

**Test surface**: `apps/web/src/app/world-id-test` — standalone, not wired into
payments, prints the active preset and environment on screen so a reviewer can
confirm what was requested without reading source. Signing happens only in
`api/world-id/rp-signature`; the served HTML was grepped to confirm the key
never reaches the client bundle.

### D49a · Nullifier continuity confirmed by a second run — and two traps it exposed — `build`

The whole "is this the same person who onboarded?" design rests on one claim:
same human + same action ⇒ same nullifier. Verifying twice as the same person
confirms it, and confirms the second run was a genuinely fresh proof rather than
a cached response:

| Field | Run 1 | Run 2 |
|---|---|---|
| `nonce` | `0x00aefa23…` | `0x001e91d7…` |
| `merkle_root` | `0x1a7f791c…` | `0x206b1e80…` |
| `proof` | different bytes | different bytes |
| **`nullifier`** | `0x17a81bf1…` | **`0x17a81bf1…`** |

New proof, new nonce, different merkle root, identical nullifier. Continuity is
observed, not assumed — so onboarding can store the nullifier and any later gate
can compare against it, with no photo held by us and no biometric ever crossing
into our custody.

**Trap 1 — World detects nullifier reuse and approves it anyway.** Run 2 came
back `"Proof verified successfully (nullifier reuse)"` with `success: true` and
HTTP 200. The verifier annotates reuse; it does not reject it. Anything gating on
`success` alone would let the same person approve the same payment indefinitely.
Replay protection is entirely ours — the `UNIQUE (nullifier, action, signal)`
constraint is the control, and the upstream hint is diagnostics only: it is an
unstructured `message` string, and `success` does not change.

**Trap 2 — `created_at` is first-seen, not verified-at.** Both runs returned
`created_at: 2026-09-09T22:15:54.351489+00:00`, hours apart. It timestamps when
the nullifier was first observed, not this verification. Persisting it as the
verification time would put a wrong timestamp in the evidence chain; the server's
own clock is the source of truth for `verifiedAt`.

**Not tested**: that a different person yields a different nullifier. One test
subject was available. It follows from the protocol's design but has not been
observed here, and must not be described as verified.

### D49b · The v4 verifier does not check your signal — that moved to us — `security`

Caught by reading the migration guide rather than by testing, because nothing
about it fails visibly.

The v3 API took the signal explicitly:

```ts
verifyCloudProof(proof, app_id, action, signal)
```

The v4 endpoint takes the IDKit payload and nothing else. It is therefore never
told which signal we *expected*, and cannot be: a successful verification means
only "this proof is valid for whatever `signal_hash` is inside it". Confirming
that is the signal we asked for is now entirely the integrator's job, and the
docs never say so in those words.

The first cut of `WorldIdService` had exactly this hole: it took the caller's
`signal`, stored it, and never compared it to the proof. A genuine,
correctly-signed proof bound to *anything else* — including the empty signal,
which is what an unbound request produces and what both our captures carry —
would have been recorded as authorising that specific payment. The row would
have looked perfect.

**Fix**: compare before storing, using the SDK's own hasher so we are not
reimplementing the field-element encoding:

```ts
if (verified.signalHash !== hashSignal(input.signal)) throw new SignalMismatchError(...)
```

`hashSignal` comes from `@worldcoin/idkit-core/hashing`, which is why the API now
depends on `idkit-core` despite never rendering a widget.

**Related trap in the same guide, not yet a bug for us but one to remember**:
"Legacy presets return the maximum credential a user has." Requesting
`selfieCheckLegacy` can return an **Orb** credential if the user holds one, so
`identifier` is not guaranteed to be `"selfie"`. That direction is an assurance
upgrade so accepting it is right, but any policy keyed on the literal string
`"selfie"` would reject the strongest users. The credential is recorded per row
rather than assumed.

**General lesson, and the third time this project has paid for it** (D43 Zod in
WASM, D44 the invented endpoint): a check that silently moved from the provider
to us is worse than a missing feature, because everything keeps returning 200.
The only defence is reading the migration notes for what *stopped* being done on
our behalf — not just what the new API accepts.

### D50 · Credential claims are assertions, not evidence — `build`

The credential is referenced from a public chain and may be disclosed in full,
so it has to be safe to disclose in full. Every claim is a boolean, an enum, or
an opaque identifier — it asserts THAT each check passed, never what the
documents said. Two tests enforce this: one over the issued object, one over the
persisted row, both asserting the payee's name, Aadhaar digits, phone and
address do not appear.

- **EIP-712, not JWS.** The on-chain `issuer` argument is an address, so a
  verifier recovers the signer and compares it directly — no key-resolution step
- **the signature covers a hash of the whole claim set**, so adding a claim later
  cannot silently produce a credential that verifies against an older shape
- **chainId is in the domain**: a testnet credential will not verify on mainnet
- **`expiresAt` comes from `aadhaarKycTtl`** and becomes the on-chain `validTo`.
  D06's time-bounded verification becomes an on-chain expiry, so a stale identity
  stops being transferable without anyone remembering to act
- **`usable` is computed on read, never stored.** A cached flag goes stale the
  moment the expiry passes, and this gates an on-chain grant
- **no issuer key means no credential**, rather than an unsigned one — fails closed

**Test-hygiene consequence, learned the hard way**: `VerifiableCredential` holds
`onDelete: Restrict` FKs to both Vendor and VendorWallet, so any suite cleanup
that skipped it threw, left rows behind, and the next run inherited them. The
suite degraded from 26 seconds to 40 minutes across runs before the cause was
obvious. Every suite that confirms a wallet now deletes credentials first.

### D51 · The on-chain grant is a separate, retryable step — `build`

**Not folded into `callback-confirm`.** Vendor onboarding must not depend on a
chain being reachable: an RPC outage, or a security that has not been issued
yet, would otherwise block a verification that is complete and correct
off-chain. So confirmation mints the credential, and
`POST /vendors/:id/wallets/:walletId/grant-kyc` submits it separately and can be
retried.

**Four guards before anything is submitted:**

- wallet must be `CONFIRMED` — the grant asserts the platform verified this payee, and a wallet that never cleared the three gates (D34) has nothing to assert
- `ATS_SECURITY_ID` must be set — no token to grant against means the call would go into the void
- credential must be usable — putting a stale assertion on chain with an already-passed validity window is worse than not granting
- credential issuer must equal the gateway's issuer address — the chain records `issuer` as an address, and a mismatch means a verifier cannot connect the credential to the grant
- plus `grantedTxHash` makes a second grant a 409

**Waits for the receipt.** A submitted transaction that later reverts would
leave the platform believing a wallet is transferable when the token disagrees.

**Address resolution goes through the mirror node**, deliberately not the
"long-zero" derivation (`0x` + padded entity number). Long-zero is only valid
for entities that never received a distinct EVM address; a contract deployed
through the ATS factory has a real one — `0.0.9213391` resolves to
`0xd1f118a4…`, nothing like its long-zero form. Using long-zero would address a
different, non-existent account.

**The ABI is pinned and tested**, trimmed to the four functions used. A drifted
signature would encode a call the contract rejects, and a test asserts
`grantKyc(address,string,uint256,uint256,address)` against `IKyc.json` 8.0.0.

**Missing config yields the mock**, not a half-wired client that fails at call
time — and the mock reports `broadcast: false`, so its result can never be
presented as an on-chain grant (D21, D32).

### D52 · Issuance is headless against the factory ABI, and every failure taught a rule — `build`

The SDK is browser-only (D42), but the contracts package ships ABIs — so
issuance runs from `packages/contracts/scripts/deploy-testnet.ts` instead of a
UI. Reproducible, reviewable, in the repo as evidence ATS was actually used, and
re-runnable for a fresh security whenever one is needed.

**Live result**: bond `0.0.10444329` (`0x8418e766…`), internal KYC enforced,
issuer registered, one payee granted — verified by reading `getKycStatusFor`:
the granted wallet returns 1, an unrelated address returns 0.

Four reverts, each now encoded as a guard so it cannot recur:

| Revert | Rule learned |
|---|---|
| `WrongISINChecksum` | the factory enforces ISO 6166. `completeIsin()` computes the check digit, validated against four real published ISINs |
| `RegulationTypeAndSubTypeForbidden(0,0)` | only REG_S+NONE or REG_D+506_x are accepted. NONE/NONE reverts. Defaults to Reg S — the offering is outside the US |
| `NewMaxSupplyCannotBeZero` | zero is rejected, not treated as uncapped |
| `AccountIsNotIssuer` | `grantKyc` only honours an issuer registered via `addIssuer`, which itself needs `ROLE_SSI_MANAGER`. That check is the point, not an obstacle: the token trusts credentials from issuers it was told to trust |

A fifth failure was ours: `deployBond` succeeded but the address could not be
decoded, because the `BondDeployed` event carries two nested structs that our
partial ABI omitted, giving a different topic hash. Now the new proxy is
identified as the log emitter that is not the factory — stable regardless of
event shape.

**Broadcasting is opt-in.** `COMPLIANCE_GATEWAY` defaults to `mock`; only
`ats` writes real transactions. Inferring it from the presence of credentials
meant every test process silently selected the live chain the moment the Hedera
keys were filled in — one test did reach the network before this was fixed.

### D53 · The compliance gate is demonstrated by a transfer that fails — `build`

`pnpm --filter @cp/contracts lifecycle` runs the whole story against testnet:

1. mint units of the receivable to the KYC-granted payee
2. the payee attempts a transfer to an address the platform never verified — **rejected by the contract**
3. the platform grants KYC to that address
4. the same transfer, retried — **succeeds**

Step 2 is the deliverable. Anyone can show a token moving; showing a token
*refusing* to move, because our DigiLocker pipeline never confirmed the
recipient, is what makes the compliance control real rather than a badge beside
one. Balances afterwards: payee 90000, recipient 10000, supply 100000.

**`validTo = 0` is not "no expiry".** The contract rejects it with
`InvalidDates()`. Encoding a missing `aadhaarKycTtl` as zero would have failed
every grant for a credential without a TTL — in production, not just the demo.
It is now a far-future date, and `NO_EXPIRY_SECONDS` documents why.

`mint` needs `ROLE_ISSUER`, granted on demand by the script. The demo is
idempotent and re-runnable, which matters because it is what the video films.

### D54 · Duplicate detection belongs in the engine; a block that nobody investigates is half a control — `build`

**`isDuplicate` is an input to `decide()`**, not a check scattered in the
payment service. Ranked immediately after sanctions and before every payee
check, because it is about the PAYMENT rather than the party: a duplicate to a
perfectly verified vendor is still money gone. Precedence is tested — a
sanctions hit still wins.

**Matched on vendor + invoiceRef against settled payments only.** Amount is
deliberately excluded: a duplicate raised for a slightly different figure is the
common shape of the mistake, and matching on amount would miss exactly those.

**Blocking is not enough.** A blocked duplicate opens an `ExceptionCase` in the
same transaction as the decision and its evidence (D07) — someone has to find
out why a second payment was raised for a settled invoice. Verified end to end:
the payment stays at `DECISION_PENDING`, `propose` returns 422, and the case
carries its playbook.

**Playbooks are ordered, concrete actions**, not status labels. For a misdirect
the first step is "freeze further payments to this vendor wallet" — stop the
bleeding before investigating. An exception desk that does not say what to do
next is a list.

**A resolved case cannot be mutated.** Reopening by edit would erase what was
decided; a new case is the honest way to revisit it.

**Acknowledgment is non-repudiation of receipt.** The signature must recover to
the address the money actually went to — otherwise a third party could
manufacture a receipt for someone else's payment. The raw context is encrypted
into an `ACK_CONTEXT` blob and only the commitment reaches the evidence chain,
with a test asserting the invoice reference does not appear in the payload.

Both the server and the recipient hash the context with sorted keys, since the
signer builds that object independently and insertion order must not change the
commitment (D36).

**TLS 1.3 removed from the checklist**, not deferred silently: everything runs
on localhost, so there is nothing to terminate TLS on. It is a real requirement
the moment anything is deployed, and it is recorded as `[-]` with that reason
rather than left as an open task that will never be ticked.

### D55 · TLS has three modes, and the bridge leg is the one that matters — `build`

Reversing the earlier call to drop TLS as localhost-only: the app is being
deployed, so it is implemented properly and works in both places.

```
off        plain HTTP. Local development only; production refuses to boot with it
terminated a proxy terminates TLS. The app trusts x-forwarded-proto and answers
           426 for anything that reached the proxy in the clear
direct     this process serves HTTPS itself, minVersion TLSv1.3
```

**Explicit, never inferred from NODE_ENV.** "Is this connection encrypted" is
not something to guess at, and inferring it is how a staging box ends up serving
plaintext while believing otherwise.

**`trustProxy` is enabled only in `terminated` mode.** Trusting forwarded
headers with nothing in front would let a client set its own `x-forwarded-for`
and `x-forwarded-proto` — spoofing its IP past rate limiting and claiming an
encrypted connection it does not have.

**426, not a redirect.** This is an API; silently redirecting a POST drops its
body while looking like it worked. Health probes are exempt so an internal check
does not read as an outage.

**HSTS only when the connection is actually encrypted** — sending it over plain
HTTP locally would pin a browser to `https://localhost` and break every other
project on that origin.

**The bridge leg is the reason any of this matters.** The bridge holds the only
signing key and prints a recipient and amount for a human to confirm. Anyone
able to sit on that connection chooses what the operator sees, and therefore
where the money goes — the human confirmation step is only as trustworthy as the
channel feeding it. So:

- a plaintext `API_BASE_URL` is refused unless `BRIDGE_ALLOW_INSECURE=true` is set deliberately
- a private CA is trusted by **adding** it (`BRIDGE_CA_CERT_PATH`), and there is no setting anywhere that disables certificate verification
- `cert:dev` generates a local certificate, so development exercises the same verification path as a deployment rather than skipping it

Verified end to end: TLS 1.3 negotiated, plaintext refused on the TLS port,
`curl` succeeds against the CA without `-k`, the bridge works with the CA and
fails without it.

### D56 · The contract suite tested the mock, not the chain — `build`

`packages/contracts` had 11 green tests. Every one of them asserted an ABI shape
or exercised `MockComplianceGateway`; not one touched Hedera. So `pnpm test`
proved the mock worked and said nothing about the on-chain integration — while
looking, to anyone reading the output, like it proved both. That is D44's
failure mode again, and in the track carrying the largest weighting.

The deployment was real — confirmed by querying the public mirror node directly:
bond `0.0.10444329` = `0x8418e766…`, not deleted, 23 successful calls including
mint / transfer / approve, and **two reverts**. But that proof lived in a chat
message, not in the repo, and nothing would notice if it stopped being true.

**Fix**: `test/onchain.test.ts` re-queries the public mirror node and asserts the
deployment recorded in `fixtures/hedera/deployment.json` still holds — the
contracts exist, the bond's `created_timestamp` still matches (so a swapped
contract is caught, not just a missing one), mint/transfer/approve are present,
and a revert whose error data begins `0x1c94559c` is there.

That last assertion is the one worth having. **The compliance gate refusing a
transfer on-chain is the only evidence that the restriction is enforced by the
contract rather than by our application politely declining** (D53). It cannot be
demonstrated from inside our own code at all.

**Deliberately fails rather than skips when the mirror node is unreachable.** A
suite that quietly skips its only real check would report "on-chain verified" on
a laptop with no network. Read-only, no key, no account, no broadcast — a judge
can run it.

**Still not closed**: in THIS repo the API resolves `complianceGateway: "mock"`.
The public infrastructure values are now in `.env` (RPC relay, mirror node,
factory, resolver, bond), so the only gap is a FUNDED Hedera account. Ours
(`0x7b83c510…`) is not one — the mirror node returns "Not found" — so it can
sign credentials but cannot pay gas. Until that is supplied, `grant-kyc` cannot
broadcast here, and the honest claim is "the asset is live and verifiable; this
repo reads it but does not yet write to it".

### D57 · One lifecycle operation met the bar; it did not meet the brief — `build`

The qualification bar says "at least one lifecycle operation", and mint plus a
compliance-gated transfer satisfied it. The judging line says "real lifecycle
management will be favoured over a token with a name on it" — and one transfer
is thin against that. Stopping at the bar was the wrong call on the
highest-priority track.

`pnpm --filter @cp/contracts lifecycle` now runs the whole thing on testnet:

```
1. mint 500.00 units to the KYC-granted payee
2. transfer to an unverified address        -> REJECTED on chain
3. platform grants KYC to that address
4. same transfer retried                    -> succeeds
5. coupon scheduled                         -> corporate action, count 1 -> 2
6. maturity moved forward, holding redeemed -> 300000 -> 0, supply reduced
```

Three contract behaviours that were not guessable:

- **`rateStatus` must be `SET` (1), not `PENDING` (0)**, for a STANDARD-rate bond. `PENDING` is for a rate fixed later at the fixing date, and the contract rejects it at scheduling with `InterestRateIsStandard()`
- **A maturity date must be strictly in the future.** `MaturityDateInvalid()` covers both directions — setting one in the past, and redeeming before it is reached — so the demo sets maturity just ahead and waits out **chain** time, which is what the contract compares against
- **Every lifecycle role is now granted at deploy** (ISSUER, CORPORATE_ACTION, MATURITY_MANAGER, MATURITY_REDEEMER, plus the KYC and SSI ones), so a fresh security needs no follow-up grants

**The demo is idempotent**, and that mattered: on a second run the counterparty
still had KYC from the first, so the step-2 rejection silently did not happen
and the script reported success anyway. It now revokes that KYC first. A demo
that quietly stops demonstrating its own point is worse than one that fails.

Related: the summary printed "yes" for coupon and redemption while neither had
run, because one edit landed and another did not. Every summary line now reports
an observed value — a count that increased, a holding that fell.
### D58 · Building the HTLC settlement leg: six calls D41 did not anticipate — `build`

D41 set the shape. These are the decisions that only appeared once it was on chain.

**The escrow does NOT attach at `redeemAtMaturityByPartition`, as D41 said it
would.** Redemption burns a holding back to the issuer — there is no second
asset to escrow and no counterparty to claim. The receipt matters one step
earlier, at the payout leg: the transfer to a payee. So the escrow wraps a
transfer of the security, and redemption stays what it is. D41's instinct was
right about *why*; it was wrong about *where*.

**The escrow needs its own KYC on the security.** It holds the token while a
lock is open, so it is a holder and the transfer rules apply to it. Every lock
reverted until `deploy:htlc` granted it. Worth keeping as a demo beat rather
than hiding: a contract that could hold a regulated security without being
approved to would be a hole in the control, not a feature of it.

**Claim is restricted to the payee, unlike a conventional HTLC.** The textbook
version lets anyone push funds along once the preimage is public. Here the
receipt property comes from *who signed the claim* — a relayed claim would move
the money and prove nothing about the payee.

**Claiming closes when the timelock passes.** Claim and refund are therefore
never both available, and every lock ends in exactly one of two states. An
evidence chain that could show both is an evidence chain nobody can read back.

**Refund is callable by anyone; funds only ever go to the recorded payer.** The
open caller cannot redirect anything, and recovery stops depending on the payer's
key still working. Money stuck because one key went quiet is the failure this
product exists to prevent — it would be absurd to reintroduce it in the recovery
path.

**One acknowledgment concept, two ways to produce it.** The HTLC claim writes to
`RecipientAcknowledgment` with `method = HTLC_CLAIM`, alongside the EIP-712 rows.
A dispute asks "did the payee acknowledge receipt", and the answer must not
depend on which settlement mode was chosen. This forced `recipientSignature`
nullable: there is no EIP-712 payload anywhere in the claim flow, and inventing
one would make the record read like something it is not.

**A refund opens a MISDIRECT exception.** The money coming back is the good
outcome. A verified payee never collecting an approved payment is not — and
nobody finds out from a balance quietly returning to normal.

Three smaller ones:

- **The lock id is re-derived server-side** from the reported parameters and a
  mismatch is rejected. Needed `tokenAddress` and `onChainAmount` columns, since
  the human amount and a token symbol are not enough to reproduce the hash. A
  lock stored under an id the chain never issued is money nobody can find again
- **`recommendSettlementMode` is advisory and sits outside `decide()`.** The
  decision engine says whether money may move; this says how it should travel.
  Folding them together would make an escrow read as an extra approval gate.
  It recommends HTLC only for `NEW_OR_CHANGED_ADDRESS` — every check passed and
  the only remaining risk is that the address is not who we think it is
- **The compiled artifact is committed as TypeScript** (solc 0.8.36, evm `paris`,
  optimizer 200 runs) rather than built on install. Every internal package here
  is consumed as source; one contract should not impose a build order on the
  workspace. `paris` because Hedera's EVM tracks upstream but not instantly, and
  a single unsupported opcode is a bad thing to discover mid-demo

**Proven on testnet, both branches**, in the same run as the ATS lifecycle:
locked 5000 → a wrong secret rejected → payee claimed and the preimage is on
chain; then locked 2500 → an early refund rejected → timelock passed → refunded,
payee restored. Escrow: `0x8ad684cff71aa37c7aa5a53b3a443dcd3e82285e`.

**Still not wired: the bridge does not broadcast either mode.** `local` transport
has always thrown on the ERC-20 transfer it never implemented, so HTLC is not
behind by comparison. The transport now receives `settlementMode` so the seam
cannot silently send a plain transfer for a payment approved as an escrow —
which would be the one failure worse than not sending at all.
### D59 · The API can now move money, and that is a change of posture — `build`

Chain operations lived in scripts. A consumer UI cannot run a script, so each
one a person or a scheduler triggers became a route. Doing that required
breaking a rule this codebase had held since D12, and it should be recorded as
broken rather than quietly amended.

**What survives, and what does not.** Autonomous code still cannot approve a
payout: `/payments/:id/settle` is approver-scoped and refuses anything that is
not AWAITING_APPROVAL. Role separation is still structural — each role verifies
against its own secret, so an agent token presented to an issuer route fails the
signature check before any role comparison runs, which is why it returns 401 and
not 403. What is gone is "the API process cannot move money". It can. The honest
statement is now: moving money requires an approver-scoped token and leaves an
evidence record.

**A fourth role, `issuer`, with its own secret.** Minting an instrument and
releasing someone else's payout are different authorities. Folding issuance into
`approver` would have meant one token that can both create value and send it.

**Two keys, and the fallback is announced.** The issuer key mints; the treasury
key spends. They are the same value in this demo, and the startup log says so —
"the mint key also spends" is a deployment fact, not a detail to discover later.

**`CHAIN_GATEWAY`, separate from `COMPLIANCE_GATEWAY`, and both default to mock.**
KYC grants cost gas; these routes move value. A checkout with real credentials in
`.env` must not be able to spend by accident (D21). The mock is not a no-op — it
keeps balances in memory, so a mint really moves a balance and a lock really
debits the treasury. What it deliberately does not simulate is the compliance
gate: that is proven on the real chain (D46), and a fake version would only teach
the suite to trust a rule it invented.

**The secret is the escrow, so a role token cannot buy it.** For an HTLC payment
the platform generates the preimage, publishes only its hash, and stores the
secret AES-256-GCM encrypted. Releasing it on an API token would make the
platform's own key sufficient to collect someone else's payment. Release requires
an EIP-712 `SecretRelease` signed by the payout address, and the lock id is in the
payload so a signature captured for one escrow cannot open the payee's next one.
The preimage never enters the settlement row or the evidence chain before it is
spent.

**Amounts are human decimals; the scale is read from chain.** `decimals()` is
queried, never assumed, and the conversion runs on strings. A UI that had to know
the scale would eventually be wrong by two, which is the difference between
paying a vendor and paying them a hundred times over.

**Holders are named by wallet id, never by address.** Minting to an arbitrary
address would route value past the whole confirmation pipeline (D01, D34). The one
exception is `toTreasury`, which is how an instrument gets funded before it is
paid out — without it the settle route had nothing to move.

Three smaller calls:

- **Issue and prepare are one call.** A security that exists but has no
  registered credential issuer looks fine and rejects every KYC grant made
  against it, surfacing much later as an unexplained revert during a payout (D40)
- **A refund opens a MISDIRECT case, from both the manual route and the sweep.**
  The money returning is the good outcome; a verified payee who never collected
  an approved payment is not, and nobody learns that from a balance quietly
  going back to normal
- **Sweeps report failures instead of stopping.** One holder whose redemption
  reverts must not leave every later holder unredeemed

**Proven live, through the routes.** `pnpm --filter @cp/api smoke:chain` boots the
real server against Hedera testnet and drives `POST /securities`, mint, coupon,
`POST /payments/:id/settle`, the signed secret release, and the payee's own claim.
It deployed bond `0x246840eabb0652e6e7b18536713600f979b4c1dc`, opened an escrow,
and recorded the acknowledgment as `HTLC_CLAIM`. It is a script and not a suite
because it spends real gas, and a suite that did this on every run is one bad
merge from an expensive accident.

**Still open.** The bridge broadcasts neither settlement mode — its `local`
transport has always thrown on the ERC-20 transfer it never implemented, so the
API is now ahead of it. Migrations run by hand and need `prisma migrate deploy`
in a release step. The bridge reads its keystore from a file path that will not
exist on Railway or Render.
### D60 · Anchoring is only worth doing if someone else can check it — `build`

D19 said to publish a Merkle root every fifteen minutes. Building it made clear
what the root is actually for, and most of the decisions below follow from that
one point.

**The hash chain protects against a tamperer; it does not protect against us.**
It proves nobody edited a record without editing every later one — to anyone who
trusts our database. The chain and the records live in the same store we
control, so it cannot rule out our rewriting the lot. A root on a public topic
can: it fixes a 32-byte commitment at a consensus timestamp we cannot move.

**So the inclusion proof is the deliverable, not the anchor.** Publishing is the
easy half. `GET /evidence/records/:id/proof` returns a leaf, its siblings, the
root, the public mirror-node URL of the message that root was published in, and
the algorithm itself. Verifying needs keccak256 and nothing from this system. The
algorithm is in the response body rather than in documentation somebody has to
find, because a verifier who gets the prefixes or the odd-node rule wrong fails
silently.

**Three Merkle choices that are easy to get wrong, and all three are tested.**

- **Domain separation.** Leaves hash with a `0x00` prefix, internal nodes with
  `0x01`. Without it an attacker presents an internal node as a leaf and proves
  inclusion of data that was never in the tree
- **Odd nodes are promoted, not duplicated.** Bitcoin duplicates the last node,
  which lets two different leaf sets produce the same root. Promotion, as in RFC
  6962, has no such collision
- **Pairs are never sorted.** Sorted pairs make proofs marginally smaller and
  make a proof valid at more than one position. Position is precisely what an
  inclusion proof claims, so each step carries a side instead

**Batch order is part of the commitment.** Records order by `createdAt` then
`id`, and that order is re-derived when a proof is built later. The tie-break on
id is not cosmetic: two records written in the same transaction share a
timestamp, and without it a proof would intermittently fail against a root that
was perfectly correct.

**Publish first, then write the database.** If the submission throws, nothing is
marked anchored and the next run retries the same batch. The reverse order can
mark records anchored against a message that never landed, and every inclusion
proof built afterwards would point at nothing.

**Verification is a separate step, and anchoring is not done without it.**
Submitting is not publishing; a third party being able to read it is. `verify`
fetches the message from a mirror node, checks the root matches what we recorded,
and only then marks the anchor verified. It returns 409 while the message is
still propagating, which takes a few seconds and is a wait rather than a failure.

**A third gateway switch, mock by default.** `ANCHOR_GATEWAY` sits alongside
`COMPLIANCE_GATEWAY` and `CHAIN_GATEWAY` because this is a third kind of write:
not KYC, not value, but publishing a commitment. Mock by default so a test run
never interleaves synthetic roots with real ones — a topic with test data mixed
in is worse than one with gaps, since the topic's whole value is that everything
on it is real. The mock keeps what it was given so the publish-read-verify round
trip is testable, and its topic id is `0.0.0` so nothing can be mistaken for real.

**No submit key on the topic.** Restricting submission would mean only we can
write to it. The value here is public readability, not private writability, and
our messages carry our payer account id either way.

**Two bugs found by doing it, both deployment-relevant.**

- **Empty environment values now count as unset.** Hosting platforms inject
  `KEY=` for variables nobody set, and an empty string is not absent to Zod: an
  optional field with a format rule fails on `""` and takes the whole boot down.
  This is what one `.env` shape working both locally and on a platform that
  pre-declares every key depends on
- **The consensus client is closed on shutdown.** It holds open gRPC channels
  that keep the event loop alive, so without the hook the process never exits, a
  graceful stop hangs until the platform SIGKILLs it, and in-flight requests die
  with it

**Proven live.** `pnpm --filter @cp/api smoke:anchor` published a root to topic
`0.0.10454706`, waited for a mirror node to serve it back, rebuilt the root by
following the algorithm the proof response states, and matched it against the
public message. No credentials on the read path.
### D61 · React Bits is vendored, and the palette means something — `build`

The landing page is the first thing anyone sees, including judges, so two
choices are worth writing down.

**React Bits components are copied in, not depended on.** That is how the
library ships — source into your project, no package — and it matters here
because every one of them needed changing. Each file carries the upstream URL
and marks every edit `ADAPTED`, so the diff against upstream stays legible:

- `"use client"` on all five. They touch WebGL, canvas, pointer and window, and
  none can render on the server under the App Router
- **Prism** reads `offset` through stable scalars. Upstream lists `offset?.x` in
  the effect dependencies, which tears down and rebuilds the entire WebGL
  context on every render when a caller passes an object literal
- **LetterGlitch** has its props made optional. Upstream declares six of them
  required despite giving every one a default, so it cannot be used the way its
  own defaults intend without restating all six
- **SpotlightCard** loses its hardcoded `neutral-900` surface, which fights any
  palette but its own
- **ShinyText** types its style as `MotionStyle`. Spreading `CSSProperties` into
  motion fails under this workspace's `exactOptionalPropertyTypes`, and
  narrowing one file beats relaxing the compiler for the whole app
- **CardNav** inlines its one arrow glyph rather than importing `react-icons`,
  takes its call-to-action label and destination as props instead of hardcoding
  a "Get Started" button that goes nowhere, routes internal links through
  `next/link` so in-app navigation is not a full document load, and gains a
  `glass` prop. Upstream paints a flat colour; `glass` adds a backdrop blur, a
  hairline edge and a lit top rim so the prism shows through softened instead of
  being covered. It is off by default, so upstream's look is still what you get
  without asking. Three details make it read as a pane rather than a tint:
  `backdrop-saturate` keeps colour behind the glass from going grey once
  blurred, an inset top highlight gives it an edge, and the cards blur *less*
  than the bar — matching it flattens the two into one surface. The call to
  action stays fully opaque, because the one thing on a nav that should not
  recede is the way into the product

**The hero says one thing.** First pass carried a badge, a two-clause headline,
a paragraph, and a three-figure stat strip. All of it was true and all of it had
a section of its own further down, so above the fold it was just a longer fold.
It is now a heading, two lines, and two buttons. The headline is plain white:
a gradient over an already-colourful render is two things competing for the same
attention, and the render wins.

The prism runs at its own defaults rather than the muted, hue-shifted settings
of the first pass. Those made it belong to the palette and also made it barely
visible, which is a poor trade for the one piece of artwork on the page. The
scrims are now two light passes that exist to hold the type legible, not to dim
the render.

**CardNav sits inside the hero, and scrolls away with it.** That is upstream's
design — it positions absolutely, not fixed — and it needs the hero as its
containing block to sit over the prism rather than over the top of the document.
A one-word change makes it sticky if that turns out to matter.

**Colour is reserved, not decorative.** One cool blue for anything actionable,
one green that only ever means verified, one red that only ever means blocked,
and near-black for everything else. A control layer in front of other people's
money should read as calm and deliberate; if green appeared as decoration it
would stop meaning "this passed" everywhere else in the product.

The prism is hue-shifted into that same blue rather than left rainbow, so the
artwork belongs to the palette instead of competing with it, and it suspends its
render loop once scrolled past — it is a hundred-step raymarch per frame and has
no business heating a laptop it is no longer visible on.

**Reduced motion is handled twice.** Once in CSS for transitions, and once in JS
inside the scroll reveal, because a CSS rule that shortens a duration still
plays the movement. Anyone who asked their system to stop animation gets a still
page, not a faster one.

**The page states nothing it cannot back.** The three hero figures are product
facts, not market statistics: three gates before an address is payable, zero
payouts an autonomous agent can release, twenty-four hours to recover a
misdirected one. Inventing an industry number would have been easy and would
have been the one thing on the page nobody could check.
