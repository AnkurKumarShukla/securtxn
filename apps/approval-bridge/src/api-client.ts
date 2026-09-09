// The bridge's ONLY network surface.
//
// It imports nothing from apps/api and shares no process with it — it speaks
// HTTP with a role-scoped token. That isolation is what makes "autonomous code
// cannot move money" structural rather than a convention (D12).
//
// Spec: docs/architecture.md §4.3

import { PendingProposalList, type PendingProposal, type ReportSentRequest } from "@cp/shared-types";
import type { BridgeConfig } from "./config.js";

export class ApiClient {
  constructor(private readonly config: BridgeConfig) {}

  async listPending(): Promise<PendingProposal[]> {
    const body = await this.request("GET", "/approvals/pending");
    // Parsed, not trusted: the queue drives what an operator is asked to sign,
    // so a malformed row must fail loudly rather than render blank fields.
    return PendingProposalList.parse(body).proposals;
  }

  async reportSent(proposalId: string, input: ReportSentRequest): Promise<void> {
    await this.request("POST", `/approvals/${proposalId}/report-sent`, input);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.config.BRIDGE_TOKEN) {
      throw new Error("BRIDGE_TOKEN is not set; the bridge cannot reach the approval queue");
    }

    const response = await fetch(`${this.config.API_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.BRIDGE_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`API ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text === "" ? null : JSON.parse(text);
  }
}
