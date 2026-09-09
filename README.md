# Confirmed Payee + Exception Desk

A control layer in front of stablecoin custodians that prevents the most
expensive failure in crypto B2B payments — sending money to the wrong wallet,
irrecoverably. Pre-send beneficiary verification, human + hardware-gated
approval, post-send exception and recovery desk.

**[docs/architecture.md](./docs/architecture.md) is the spec.** It defines every interface
and the acceptance criteria for each phase. This README covers layout only.

Working state lives in [docs/progress.md](./docs/progress.md) (what is built and
tested) and [docs/decisions.md](./docs/decisions.md) (why it is built that way).
Keep both current as you go — a ticked box means its unit test passes.

## Layout

```
apps/
  api/               Fastify + Prisma. Registry, decision engine, evidence chain
  web/               Next.js. Dashboard, onboarding, approvals, exception desk
  approval-bridge/   Node CLI on the APPROVER'S machine — the only Ledger access
packages/
  shared-types/      Zod schemas + types imported by all three apps
  cre-workflows/     VendorMatcher interface + fallback and CRE implementations
  contracts/         Hedera ATS deployment and Control List config
fixtures/
  digilocker/            real signed documents — gitignored, never commit
  digilocker-synthetic/  committed tier for CI (to be generated)
docs/
  architecture.md        the spec — interfaces + per-phase acceptance criteria
  progress.md            task checklist; ticked only after unit tests pass
  decisions.md           high-stakes decisions + reasoning
  evidence-schema.md
```

## Why the boundaries are where they are

Three splits are load-bearing and should not be collapsed for convenience:

1. **`approval-bridge` is a separate app**, not a module in `api`. Signing and
   read-only are separate processes, not separate code paths (§0 principle 5).
2. **Swappable dependencies sit behind interfaces** — `IdentityProvider`,
   `VendorMatcher`, `SanctionsScreener` — resolved only in `api/src/container.ts`.
   Three of the four external integrations are access-gated (§8); the interfaces
   are why Phases 1-3 are not blocked on any of them.
3. **`decision/` and `evidence/chain.ts` are pure.** The two things that must be
   auditable have no DB or network imports and are testable in isolation.

## Getting started

```bash
pnpm install
cp .env.example .env      # fill in; see §9
pnpm db:migrate
pnpm dev
```

Dependency versions in the package manifests are starting ranges, not verified
pins — check them on first install.

## Build order

Phases are defined in §7. Phase 1 is the core platform plus DigiLocker identity,
built against fixtures first with exactly one live run to confirm — DigiLocker
calls are billable, and it is the one integration with no access gate.
