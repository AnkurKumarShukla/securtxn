// MVP stub: always clears.
//
// A named implementation behind the real interface, NOT a missing check — the
// decision engine calls it exactly as it will call the real feed, so wiring a
// provider later changes one line in container.ts and nothing else (D09, D21).
//
// Because this can never return a hit, the DO_NOT_SEND branch it guards is
// covered by injecting `sanctionsHit: true` directly into decide(). Waiting for
// a stub to produce the case would mean that branch never executes (D21).
//
// Spec: docs/architecture.md §6

import type { SanctionsQuery, SanctionsResult, SanctionsScreener } from "./SanctionsScreener.js";

export class StubSanctionsScreener implements SanctionsScreener {
  async screen(_query: SanctionsQuery): Promise<SanctionsResult> {
    return { sanctionsHit: false, source: null, checkRef: "stub-no-screening-performed" };
  }
}
