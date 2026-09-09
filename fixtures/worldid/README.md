# World ID Selfie Check fixtures

Two real Selfie Check verifications captured from the live **sandbox** on
2026-09-09, so tests can replay the flow without a phone, a camera, or the World
verifier being reachable. Same purpose as `fixtures/digilocker/`.

## Why these are committed, unlike the DigiLocker fixtures

`fixtures/digilocker/` is gitignored because it holds a real person's Aadhaar and
PAN. These files hold **no identity data at all**:

- a **nullifier** is a one-way, RP- and action-scoped pseudonym. It cannot be
  reversed to a person, and it is meaningless outside our `rp_id` — a different
  app verifying the same human gets a completely different value
- no name, no document, no image, no facial template. World never returns the
  face; the biometric stays inside World ID (see D49)

The `proof` blobs are genuine zero-knowledge proofs. They cannot be replayed
against us for anything that matters: they are bound to the **empty signal**, and
every gate we build requires a proof bound to a specific signal, checked
server-side. Reuse is caught by `UNIQUE (nullifier, action, signal)` regardless.

If that reasoning ever stops holding — say a capture is taken with a real signal
against production — re-evaluate before committing it.

## Files

| File | What it captures |
|---|---|
| `01_selfie_check_first.json` | First verification. Upstream message carries no reuse annotation. |
| `02_selfie_check_reuse.json` | Same person, same action, **fresh** proof. Identical nullifier. |
| `index.json` | The oracle: what a correct implementation must conclude, plus the gotchas. |

## What the pair proves

Capture 02 has a different `nonce`, a different `merkle_root` and completely
different `proof` bytes from capture 01 — a genuinely new proof, not a cached
response — and the **same nullifier**. That is the continuity property the
onboarding-to-approval design depends on: same human, same action, same
nullifier, forever. See D49a.

Read `index.json` → `known_gotchas` before writing anything against these. Four
of the five are traps that fail silently.
