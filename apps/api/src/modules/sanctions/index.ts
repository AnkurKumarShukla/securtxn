// Screener selection. Only the stub exists for the MVP (§6).

import type { Config } from "../../config/index.js";
import type { SanctionsScreener } from "./SanctionsScreener.js";
import { StubSanctionsScreener } from "./StubSanctionsScreener.js";

export function createSanctionsScreener(_config: Config): SanctionsScreener {
  return new StubSanctionsScreener();
}

export type { SanctionsScreener, SanctionsQuery, SanctionsResult } from "./SanctionsScreener.js";
export { StubSanctionsScreener } from "./StubSanctionsScreener.js";
