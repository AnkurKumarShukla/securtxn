# @cp/web

AP dashboard, vendor onboarding, approval screen, exception desk, evidence viewer.

```
src/
  app/
    vendors/            list, detail, onboarding form
    payments/           list, detail (decision + evidence summary)
    approvals/          approval screen — World ID Selfie Check widget (§4.6)
    exceptions/         exception desk
    evidence/[id]/      chain viewer; shows the break point when invalid
    mock/digilocker-consent/   local consent stub for IDENTITY_PROVIDER=mock (§4.7.1)
  components/           grouped by domain, mirroring the api's module slices
  lib/                  api client, IDKit config, display formatting
```

## UI constraints that are not cosmetic

- Selfie Check is medium assurance. Copy must say "a live human confirmed this
  action", never "identity verified" (§4.6).
- Aadhaar is only ever shown as last-4. Never build an input that accepts a full
  Aadhaar number — receiving one creates Data Vault obligations this flow is
  designed to avoid (§3).
- Approving in the UI does not send money. It writes a proposal; the send happens
  on the approver's machine via the Ledger (§4.3).
