# DigiLocker fixtures — recorded live responses

Captured from the **live** Sandbox API on 2026-09-08 so day-to-day development doesn't burn paid verification calls. Every KYC call except `/authenticate` and `/status` is billable live; replaying these is free.

## ⚠️ These files are gitignored, and must stay that way

They contain a real person's Aadhaar and PAN data. `.gitignore` excludes `fixtures/digilocker/` except this README.

**You cannot simply redact them to make them shareable.** The XML documents carry XMLDSig signatures from UIDAI and the Income Tax Department — editing a single byte invalidates the signature and breaks any signature-verification test. It's real-and-secret, or synthetic-and-unsigned; there is no redacted middle ground that still validates.

So there are two fixture tiers, and you need both:

| Tier | Contents | Committed? | Used for |
|---|---|---|---|
| **Real** (these files) | Genuine signed Aadhaar/PAN | ❌ never | Signature-verification tests, one-time integration validation |
| **Synthetic** (to be generated) | Fake names/addresses, self-signed or unsigned XML | ✅ yes | UI work, CI, everything else |

Each developer who needs real fixtures should capture their own via a live consent flow.

## Files

```
index.json                 route → fixture map, expected check results, known gotchas
01_authenticate.json       POST /authenticate                (token is SYNTHETIC)
02_user_verify.json        POST /kyc/digilocker/user/verify
03_session_init.json       POST /kyc/digilocker/sessions/init (URL now expired; shape reference)
04_session_status.json     GET  .../status                   (+ created/failed/expired variants)
05_user_profile.json       GET  .../user/profile             ('id' is SYNTHETIC)
06_document_aadhaar.json   GET  .../documents/aadhaar        → documents/aadhaar.xml
07_document_pan.json       GET  .../documents/pan            → documents/pan.xml
documents/aadhaar.xml      UNMODIFIED signed document — do not edit
documents/pan.xml          UNMODIFIED signed document — do not edit
```

Values marked SYNTHETIC are placeholders: real access tokens are credentials and real presigned S3 URLs expire within minutes, so neither belongs in a fixture.

## Using them

Point `IDENTITY_PROVIDER=mock` at this directory. `MockIdentityProvider` should read `index.json`, match on method + path, return the fixture body, and serve `documents/*.xml` in place of the presigned URL.

The one step that cannot be mocked meaningfully is human consent. In mock mode, have `startSession` return a fake `authorizationUrl` pointing at a local stub page that immediately flips the session to `succeeded` — that keeps the state machine honest without a real DigiLocker round trip.

## Assertions your implementation must satisfy

Replaying these fixtures must produce (see `expected_check_results` in `index.json`):

- `xmlSignatureVerified: true`
- `crossDocConsistent: true`
- `digilockerUserId` — the same value in both documents
- `aadhaarLast4` and `aadhaarKycTtl` as captured
- resulting tier: `TIER3_ADDRESS`

The **values** live only in `index.json`, which — unlike this README — is
gitignored. They identify a real person, so they are not repeated here and are
not hardcoded into tests; `apps/api/test/fixtures/oracle.ts` reads them at
runtime instead.

## Gotchas these fixtures exist to catch

The same person's details are formatted **three different ways** across endpoints. Normalise before comparing or your cross-document consistency check will falsely reject a legitimate user:

- **Date**: profile `19/11/2001` vs XML `19-11-2001`
- **Gender**: profile `male`, Aadhaar `M`, PAN `MALE`
- **Name case**: Aadhaar gives title case, PAN gives all caps

Also: document URLs in live responses are short-lived presigned links — download immediately, never persist the URL.

## Why not just use the vendor's test environment

`test-api.sandbox.co.in` is a mock replayer that only answers requests exactly matching examples saved in a forked Postman collection. No DigiLocker examples exist on this account, so every DigiLocker call 404s there — verified 2026-09-08, including with the payloads copied verbatim from their own docs. And even working, it would return canned data, never a real signed document. These fixtures exist because that environment is unusable for this integration.
