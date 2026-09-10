# World ID / Selfie Check — integration feedback

Written for the ETHOnline Selfie Check track feedback requirement. Everything
below happened during a real integration: World ID 4.0 IDKit `4.2.3`, Selfie
Check (`selfieCheckLegacy`) in the **sandbox** environment, app
`app_e44f3e7a022dc3b7e807acaa0efaceaa`, RP `rp_a76c7d95ea331d5a`, action
`verify-payment-approver`. Two complete camera flows were completed on the
sandbox app; both proofs verified server-side.

We have kept the raw captures — `fixtures/worldid/` — so every claim here is
reproducible rather than remembered.

Short version: **the protocol behaved exactly as documented. Most of the cost
was in things the docs do not say, and in one check that silently moved from
World's side to ours.**

---

## 1. Selfie Check docs and integration flow

### What worked well

- `credentials/11` is genuinely good: assurance level, the 90-day inactivity
  window, and "does not provide a strict one-person-one-account guarantee" are
  all stated plainly. Being told the *limits* of a credential up front is rare
  and it directly shaped where we put the control.
- The `from-idkit-standalone` migration page was the single most useful page.
  The before/after code blocks answered more questions than the reference did.
- `allow_legacy_proofs: true` being mandatory for Selfie Check is documented,
  and the SDK types make it a required field rather than an optional one. Good
  — it cannot be forgotten.

### Highest-cost issue: the signal check moved to the integrator, silently

This is the finding we would most like acted on.

The v3 API took the signal explicitly:

```ts
verifyCloudProof(proof, app_id, action, signal)
```

The v4 endpoint takes the IDKit payload and nothing else. It is therefore never
told which signal the RP *expected*, and cannot be. A successful verification
means only "this proof is valid for whatever `signal_hash` is inside it".

**Verifying that this is the signal you asked for is now entirely the
integrator's job, and no page says so.** Our first implementation had exactly
this hole: it stored the caller's `signal` and never compared it against the
proof. A genuine, correctly-signed proof bound to *any other context* — or to
the empty signal, which is what an unbound request produces — would have been
recorded as authorising a specific payment. Nothing would have looked wrong.

We only caught it by reading the migration page and noticing the v3 signature
had a parameter the v4 call does not.

**Suggested fix**: one sentence in "Verify the Proof" and in Step 5 of
`idkit/integrate` — *"The verifier does not know your expected signal. Compare
`responses[].signal_hash` against `hashSignal(yourSignal)` in your backend."*
`hashSignal` already exists in `@worldcoin/idkit-core/hashing`; it is just never
mentioned next to verification.

### Second: `UNIQUE (nullifier, action)` is the wrong advice for repeat actions

`integrate` Step 6 prescribes:

```sql
UNIQUE (nullifier, action)
```

That is correct for one-shot actions — an airdrop claim, one vote. It is
actively wrong for anything a person legitimately does more than once, because
the nullifier is *stable per person*. Our approver must approve many payments.
Applied literally, the documented constraint means **each human can approve
exactly one payment, ever**, and the second attempt is rejected as a replay.

Worse, the failure looks like the control working correctly. A team shipping the
documented schema would find out in production.

We scope uniqueness to the signal instead — `UNIQUE (nullifier, action, signal)`
with `signal = <the thing being approved>`. A sentence distinguishing one-shot
from repeatable actions would save teams a genuinely nasty bug.

### Third: legacy presets can return a different credential than you asked for

> "Legacy presets return the maximum credential a user has."

This is documented, but far from the code that consumes the result. Requesting
`selfieCheckLegacy` can return an **Orb** credential, so
`responses[].identifier` is not guaranteed to be `"selfie"`. Any policy keyed on
that literal string rejects your strongest users. Worth a warning inline in the
Selfie Check page, not only in the preset table.

---

## 2. Developer Portal: navigation, search, product discovery, debugging

### The single biggest gap: you cannot tell whether Selfie Check is enabled

Selfie Check is access-gated per app. The docs say so, and correctly warn that
"a valid app or action does not imply Selfie Check access".

**There is no way to check whether your app has it.** We looked through the
Portal MCP thoroughly: `get_team_context` and `get_app_config` return
registration status, store metadata, RP details and actions — and no field
anywhere indicates which credentials the app may request. `get_world_id_registration_status`
covers on-chain RP registration only.

So the state of a gate that determines whether your integration can work at all
is invisible to the API that describes your app. We resolved it the only way
available: **we built the whole integration and ran it**, and learned the flag
was on from `identifier: "selfie"` coming back. That is an expensive way to
discover a boolean.

**Suggested fix**: an `enabled_credentials` (or `feature_flags`) array on
`get_app_config`, and the same list visible on the app page in the Portal. If
that is hard, even a documented 4xx error code for "credential not enabled for
this app" would let integrators distinguish "not entitled" from "my code is
wrong" — currently indistinguishable.

### MCP tooling

Genuinely good, and the reason setup was fast. `get_team_context` first is the
right instruction and it works. Two notes:

- `rotate_world_id_signing_key` returns the private key exactly once, and the
  response says so clearly. Good. But `get_world_id_signing_key` offers
  `rotate_if_unavailable` — a flag that silently invalidates the existing signer
  is a sharp edge for an agent-driven tool. We passed `false` deliberately;
  defaulting it to `false` and requiring the explicit rotate tool would be safer.
- Action creation is per-environment and idempotent-feeling; creating the same
  action in `staging` and `production` was painless.

### Debugging guidance

Thin. When something fails, the docs point to `debugReport` and `request_id`,
but there is no page mapping common failure shapes to causes. Our two failures
were "signature rejected" (our own bug) and "unclear whether the credential is
gated" (above). Neither had a documented diagnostic path.

---

## 3. Sandbox app: states, proof flows, test users, errors, edge cases

### What worked

- The sandbox app is the right idea and it worked first time once installed.
  Full round trip — web page → QR → camera selfie → proof → server verification
  — with no surprises.
- Enrolment gating by email through **Developer Portal → World ID Sandbox** is
  clear once found.
- `environment: "sandbox"` in IDKit config is a single field. Good.

### Confusing: "I installed the sandbox app and see nothing"

This cost us time and we suspect it costs everyone time. The sandbox app is a
*client*; it has no browsable app list, and an `app_mode: external` app never
appears inside it. There is nothing to see until your own integration sends a
request. Our first assumption was that the install had failed.

**Suggested fix**: one line on the sandbox-access page — *"The sandbox app shows
nothing on its own. It only responds to a request from your integration; start
there."*

### Undocumented behaviour we had to discover by running it twice

Verifying twice as the same person surfaced two behaviours that are not in any
page we found, and both are traps:

**(a) The verifier approves a replayed nullifier.** The second run returned:

```json
"success": true,
"message": "Proof verified successfully (nullifier reuse)"
```

HTTP 200, `success: true`, with the reuse noted only inside a prose `message`
string. An integrator gating on `success` — the obvious thing to gate on — has
**no replay protection at all** and no error to tell them. We would suggest
either a structured boolean field (`nullifier_reused: true`) or an explicit note
in the docs that `success` is not a uniqueness guarantee.

**(b) `created_at` is first-seen, not verified-at.** Both of our runs returned
an identical `created_at` (`2026-09-09T22:15:54.351489+00:00`) hours apart. It
timestamps when the nullifier was first ever observed, not when this proof was
verified. We nearly persisted it as the verification time, which would have put
a wrong timestamp in an audit record. The field name suggests otherwise; a
one-line clarification would prevent that.

### Edge case: field elements are unpadded hex

Across our two captures, `merkle_root` came back **63 hex characters in one run
and 64 in the next** — a leading zero dropped. Nullifiers are the same kind of
256-bit field element and will be short roughly one time in sixteen.

Storing nullifiers as text therefore makes the *same person* look like two
different people intermittently — breaking continuity checks for legitimate
users and, worse, letting a replay through a `UNIQUE` index. The `NUMERIC(78,0)`
advice in Step 6 is correct and this is *why*, but the reason is not stated.
Saying "values are unpadded — do not compare or store them as strings" would
make the advice self-evidently necessary rather than arbitrary.

### Test users

The one real limitation for our use case: with a single sandbox account we could
verify that the **same** person yields the **same** nullifier, but not that a
**different** person yields a different one. That direction follows from the
protocol design, but we could not observe it. A documented way to get a second
sandbox identity — or a note that deleting and recreating the account produces a
distinct World ID — would let integrators test both directions of a continuity
check.

---

## 4. Summary: what was confusing, missing, broken, or hard to test

| | |
|---|---|
| **Broken** | Nothing. The protocol did exactly what it says. |
| **Missing** | No way to read whether Selfie Check is enabled for an app — the gate that decides whether the integration works at all is invisible to the API. |
| **Missing** | No mention that signal verification moved from the v3 API to the integrator in v4. This is a security hole, not an inconvenience. |
| **Wrong for our case** | `UNIQUE (nullifier, action)` bricks any action a person performs more than once. |
| **Confusing** | `created_at` means first-seen, not verified-at. |
| **Confusing** | `success: true` on a replayed nullifier, with reuse noted only in prose. |
| **Confusing** | Sandbox app appears empty until your own integration calls it. |
| **Hard to test** | Only one sandbox identity, so the "different person → different nullifier" direction cannot be observed. |
| **Undocumented** | Field elements are unpadded hex; string comparison is unsafe. |

### What we would fix first, if we were you

1. Expose enabled credentials on `get_app_config`. Everything else is a
   documentation edit; this one is a genuine blind spot.
2. One sentence about `signal_hash` verification next to the verify endpoint.
   It is the only item here that is a security issue rather than friction.
3. Split the nullifier-uniqueness advice into one-shot vs repeatable actions.

### What we liked

Being told plainly that Selfie Check is medium assurance and not
one-person-one-account. It let us put the control where it actually holds —
anti-automation and continuity on the approver — instead of overselling it as
identity. Documentation that states a product's limits is more useful than
documentation that only sells its strengths, and it is the reason our
integration is honest about what it proves.
