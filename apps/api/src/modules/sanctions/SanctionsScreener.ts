// Sanctions screening contract.
//
// Behind an interface so the real feed (Chainalysis / TRM / OFAC) swaps in
// without touching the decision engine (D09).
//
// Spec: docs/architecture.md §6

export type SanctionsQuery = {
  vendorId: string;
  legalName: string;
  walletAddress: string;
  network: string;
  country: string;
};

export type SanctionsResult = {
  sanctionsHit: boolean;
  /** Which list, when there is a hit. Recorded in evidence. */
  source: string | null;
  /** Provider reference for the check, so a decision can be re-justified later. */
  checkRef: string | null;
};

export interface SanctionsScreener {
  screen(query: SanctionsQuery): Promise<SanctionsResult>;
}
