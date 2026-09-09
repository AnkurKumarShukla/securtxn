# Synthetic DigiLocker fixtures

**Not yet populated.** This is the committed fixture tier — fake identities,
unsigned or self-signed XML. It is what CI and UI work run against.

The real tier (`fixtures/digilocker/`) is gitignored because it contains a real
person's Aadhaar and PAN, and cannot be redacted: editing one byte of a signed
XML invalidates the XMLDSig signature. There is no middle ground, hence two tiers
(docs/architecture.md §4.7.1).

## What to generate

Mirror the real tier's layout exactly, so `MockIdentityProvider` can point at
either directory via `DIGILOCKER_FIXTURE_DIR` with no code change:

```
index.json                 route map + expected_check_results for THIS data
01_authenticate.json  ...  07_document_pan.json
documents/aadhaar.xml      synthetic, self-signed
documents/pan.xml          synthetic, self-signed
```

## Preserve the gotchas deliberately

The synthetic set is worthless if it is internally tidy. Reproduce the three
format inconsistencies the real capture exposed, or the normalisation layer will
pass CI and fail on live data:

- date: profile `DD/MM/YYYY` vs XML `DD-MM-YYYY` (and handle a unix-ms variant)
- gender: profile `male`, Aadhaar `M`, PAN `MALE`
- name case: Aadhaar title case, PAN upper case

Signature verification against the real UIDAI chain cannot be tested here — that
assertion belongs to the real tier only. Synthetic `index.json` should expect
`xmlSignatureVerified: false` under the real CA root, and tests that need `true`
must use a test root the synthetic documents are signed against.
