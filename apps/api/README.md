# @cp/api

Core platform: vendor registry, decision engine, evidence hash-chain, exception desk.

## Layout

```
prisma/         schema (§3) + seed
src/
  index.ts      entrypoint
  server.ts     Fastify assembly
  container.ts  DI root — the only place a swappable implementation is chosen
  config/       env parsing, tier thresholds
  plugins/      prisma, auth (role separation), error handling, audit
  modules/      vertical slices; each owns routes + service + schema
    identity/     providers, the four checks, normalisation, parsers
    vendors/  wallets/  payments/  approvals/  exceptions/  evidence/
    decision/     pure state machine, no I/O
    sanctions/    interface + MVP stub
    internal/     identity-registry hook consumed by Hedera ATS
  jobs/         scheduled work (HCS anchoring)
  lib/          crypto, EIP-712, canonical JSON, Hedera client, logging
test/           integration tests; unit tests sit next to their module
```

Modules are vertical slices rather than a shared `routes/` + `services/` split:
each domain's HTTP surface, business logic and validation live together, and
cross-module calls go through a service, never through another module's routes.

`decision/` and `evidence/chain.ts` are deliberately pure — no DB or network
imports — so the two things that must be auditable are testable in isolation.

## This process never signs

It writes proposals. Only `apps/approval-bridge`, on the approver's machine,
can move funds, gated by on-device Clear Signing (§0 principle 1, §4.3).
