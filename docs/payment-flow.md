# Payment flow

Three rules drive the order:

1. **The address is untrusted routing; the identity is the verification.** The
   sender pastes an address off an invoice — exactly where hijacking lives — and
   states who they *intend* to pay. A tampered address is caught because it is
   bound to a different DigiLocker subject.
2. **Nothing is verified until the receiver agrees to be verified.** No consent,
   no verdict, nothing learned.
3. **No money moves until verification passes.** Verifying after settlement is
   detect-and-refund, which banks already do.

No pre-established payer↔payee link is required. B2B reality is that you receive
an invoice from a supplier you have never paid and you pay it; forcing a
two-sided link first is a chicken-and-egg problem for no gain — the identity
binding, not the relationship, is what defeats a tampered address.

---

## Onboarding — once per party, both sender and receiver

| | Step | Produces |
|---|---|---|
| O1 | Create vendor record | `vendorId` |
| O2 | DigiLocker: session → consent → complete | `verificationTier`; PII encrypted; PAN kept **only** as an HMAC digest |
| O3 | Register wallet | `controlProofNonce` |
| O4 | **EIP-712 control proof** — payee signs | key possession |
| O5 | **EIP-712 identity binding** | `address ↔ DigiLocker subject` |
| O6 | Callback confirm on an independently known contact | wallet `CONFIRMED`, credential minted |
| O7 | **World ID enrolment**, `signal = onboardingSessionNonce` | nullifier stored |
| O8 | `grantKyc(account, vcId, validFrom, validTo, issuer)` | ATS token accepts this address |

O2, O4 and O7 prove different things: **who**, **key possession**, **personhood
and continuity**. None substitutes for another.

---

## Payment

```
P1   sender enters, per payment:
       payee ADDRESS        ← off the invoice. UNTRUSTED.
       intended PAN + name  ← off the same invoice (GSTIN embeds the PAN)
       amount, token, invoice ref
     nothing verified · no money moved                     status: DRAFT

P2   SENDER World ID  (always)
     Selfie Check, signal = paymentId, must equal sender's enrolment nullifier
                                                          evidence: world_id_check

P3   notify the payee at that address
     shows: sender's verified legal name, amount, invoice ref
                                                          status: AWAITING_PAYEE_CONSENT

P4   payee decides
     DENY   → terminate. No match runs. No funds moved.
     ACCEPT → EIP-712 consent signed by the CONFIRMED wallet

P5   PAYEE World ID  (risk-based — triggers below)
     must equal the payee's enrolment nullifier
     → detects a STOLEN KEY: a thief can sign P4 and claim at P10,
       but cannot produce the nullifier

P6   CRE CONFIDENTIAL WORKFLOW  (TEE)
     server normalises + HMACs the sender's typed PAN and name, sends only
     DIGESTS. The payee record is stored as digests too. The enclave compares
     opaque bytes — no plaintext identity ever enters it, and no crypto is
     needed there (see below).
     NO_MATCH → blocked; payee alerted "someone claimed you and was wrong"
                                                          evidence: vendor_match

P7   decision engine
     sanctions · duplicate invoice · wallet CONFIRMED · tier ceiling
     freshness (DigiLocker TTL, credential expiry, 90-day selfie window)
     on-chain KYC granted
     → SAFE_TO_SEND | SEND_TEST_AMOUNT | REVERIFY | DO_NOT_SEND
                                                          evidence: decision

P8   proposal → human approval queue (approval-bridge holds the only key)

P9   HTLC LOCK                                     ← FIRST MOVEMENT OF MONEY
     lock(payee, token, amount, hashlock, timelock, paymentRef)
                                                          status: LOCKED · evidence: send

P10  payee claims — claim(lockId, preimage)
     settles atomically; the reveal IS the acknowledgment
                                                          status: SETTLED · evidence: ack

P11  no claim before timelock → refund(lockId), exception opened

P12  evidence hash-chained per payment; batch Merkle root → HCS topic
```

### Why P6 compares digests, not plaintext (D62)

**There is no crypto in the CRE enclave.** `node:crypto` is explicitly banned by
the SDK's restricted-modules list, and the declared globals are only
TextEncoder/Decoder, Buffer, atob/btoa, URL and console — no `crypto.subtle`,
nothing. So "encrypt at rest, decrypt inside the enclave" has no primitive to
decrypt with.

Deterministic matching sidesteps it entirely:

```
onboarding : store  HMAC(pan, pepper)  and  HMAC(normalise(name), pepper)
P6         : server HMACs the sender's typed values the same way
             enclave compares digest == digest        ← no crypto, no plaintext
```

The pepper never leaves our server, and the enclave never sees an identity.

**What this costs: the near-miss band.** Name matching was similarity ≥ 0.85, so
a typo scored ~0.95 and still matched, while 0.5 went to a human as REVERIFY.
Digests are exact — any difference is a flat mismatch.

That is partly a *gain*: fuzzy name matching is exactly how lookalike payees
("Meridian Componentz") slip through, and exact-after-normalisation is stricter
and more predictable. The real loss is diagnostic — a reviewer can no longer
tell a typo from a completely different company. The sender simply retries with
corrected input; a mismatch costs a retry, never money.

Normalisation does the heavy lifting and already works: in the live sandbox run
*"MERIDIAN COMPONENTS PRIVATE LIMITED"* and *"Meridian Components Pvt Ltd"*
normalised to score 1.0.

**One reason code for any identity mismatch.** Do not report whether the PAN or
the name failed. The sender already learns one bit (match/no-match); saying
*which* field failed gives a second bit and lets a prober isolate the PAN by
varying the name.

**Consequence for D09**: the fallback matcher must move to digests too. The two
implementations share `evaluateMatch()` precisely so they cannot drift — if the
fallback keeps fuzzy scoring while CRE compares digests, the shared contract
suite stops proving anything about the CRE path.

### Payee challenge triggers (P5)

Challenge when **any** holds: first payment from this sender · amount above the
payee's tier ceiling · payee wallet rotated within N days · payee dormant past
the 90-day Selfie Check window · a mismatch recorded against this payee recently.

Otherwise skip. Enrolment at O7 is what matters — it makes the challenge
**available** the moment something looks wrong.

---

## Why invoice fraud fails

The classic attack is a tampered invoice carrying the attacker's address.

```
sender pastes 0xBAD, states intended PAN ABCDE1234F (Meridian's)
0xBAD is KYC'd as Rakesh Traders, PAN ZZZZZ9999Z
attacker consents — of course they do
P6:  ABCDE1234F  vs  ZZZZZ9999Z  →  NO_MATCH  →  BLOCKED
```

The sender was fully tricked, right up to pasting the attacker's address, and
still did not lose the money.

And to receive at all, the attacker must complete DigiLocker KYC. **Invoice
fraud stops being free and anonymous and starts costing a real, traceable,
prosecutable identity** — revocable across every buyer on the platform at once.
That is structural, not a policy we tune.

## Residual guardrails

| Control | Why |
|---|---|
| Consent gates the match (P4 → P6) | the primary control: each probe costs the victim's active acceptance |
| Mismatch alerts the payee | makes probing visible; a silent failure is the attacker's ideal |
| Block keyed on **verified identity** | addresses rotate in seconds; a DigiLocker identity does not |

Deliberately **not** used: escrow-as-deterrent (refundable, so it costs only
gas) and punitive deductions (require custody, and punish honest buyers with
stale vendor data).

## What each sponsor does

| | Job |
|---|---|
| **DigiLocker** | who the parties legally are (O2) |
| **World ID** | a live, continuous human raised this payment (P2); on risk, that the payee accepting is the one who enrolled — detects a stolen key (P5) |
| **Chainlink CRE** | do the two parties' identity records agree, without either side seeing the other's (P6) |
| **Hedera ATS** | the token refuses an unverified address (O8); HCS makes the audit trail checkable by someone who does not trust us (P12) |

## Assurance boundaries — do not overclaim

- Selfie Check is **medium assurance**, explicitly not one-person-one-account.
  It proves *the same human as enrolled*, never *which* human.
- EIP-712 proves **key possession**, not personhood.
- DigiLocker proves **legal identity**, only as fresh as its TTL.

## Build status

**Exists**: O1-O2 DigiLocker · O3-O6 control proof, binding, callback confirm ·
O7 World ID enrol/verify · O8 on-chain KYC · P2 sender Selfie Check gate ·
P3-P4 payee consent (notification, prompt, EIP-712 acceptance) · P5 risk engine
and payee challenge · the mismatch alert · the identity block list · P6 CRE TEE
match on digests (D62) · P7 decision engine including the on-chain KYC gate ·
P8 proposal queue · P9-P11 `PaymentHtlc.sol` · P12 evidence chain + HCS
anchoring.

The sequencing is enforced in the service, not by convention: `runDecision`
refuses without an `ACCEPTED` consent (D63), and `request-consent` refuses
without the sender's World ID check for that payment (D64).

**Still open**:

- **Nothing broadcasts a transfer.** `apps/approval-bridge/src/wallet-cli.ts`
  stops at "Local broadcast is not wired yet" — it signs nothing and sends
  nothing. P9 records a lock that something else must have made.
- **The CRE deployment is stale.** `VENDOR_MATCHER` stays `fallback` because
  the workflow on the DON predates D62 — it scores plaintext names, and the
  lookup endpoint now returns only digests. `cre workflow deploy` has to publish
  the current `src/cre/` before the flip is anything but a broken payment path.
- **`COMPLIANCE_GATEWAY=ats` is the shipped default**, so the decision now
  depends on Hedera testnet being reachable and the issuer account funded.
- The repo is private and there are no demo videos; every track requires both.

## Known residual: the one-bit leak

P6 returns match/no-match to the sender, so a probe learns one bit. That is
irreducible for any check that decides whether to pay.

It is throttled, not eliminated: every probe needs the target to **actively
accept** a payment request, and the mismatch alert tells them they were probed.
Twenty probes is twenty prompts and twenty alerts to one person, who blocks the
sender. Accepted for now; revisit if abuse appears.
