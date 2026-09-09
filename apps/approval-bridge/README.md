# @cp/approval-bridge

**Runs on the approver's local machine. Never in cloud infrastructure.**

It is the only process with USB access to the Ledger, and therefore the only
thing in this system that can move money. That isolation is architectural, not a
code-path convention (§0 principle 5) — which is why this is a separate app with
its own dependency tree rather than a module inside `@cp/api`.

```
src/
  index.ts       CLI: list | approve <id> | watch
  api-client.ts  the only network surface — approver-scoped token
  wallet-cli.ts  execa wrapper; transport switches usb <-> speculos by env
  commands/
```

## Setup

```bash
npx skills add ledgerhq/agent-skills
npm i -g @ledgerhq/wallet-cli
```

## Invariants

- Nothing here imports `@cp/api`. It talks over HTTP, with an approver-scoped
  token that is rejected on `/payments/:id/propose` (§4.2).
- The confirm/reject decision happens on the physical device screen via Clear
  Signing. `wallet-cli` blocks until the device responds; the CLI prompt is a
  convenience, not the security boundary.
- `WALLET_CLI_TRANSPORT=speculos` changes only the transport target. The code
  path stays identical, so a Speculos demo exercises the real flow.
