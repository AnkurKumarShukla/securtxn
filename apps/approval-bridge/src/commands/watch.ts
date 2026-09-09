// `approval-bridge watch` — poll the queue and print new arrivals.
//
// Deliberately does NOT approve anything. Polling is unattended; approving is
// not. An auto-approving daemon would recreate exactly the thing this whole
// architecture removes (D12).

import type { ApiClient } from "../api-client.js";
import { renderProposal } from "../prompts.js";

export async function watchCommand(api: ApiClient, intervalSeconds: number): Promise<void> {
  const seen = new Set<string>();
  console.log(`Watching the approval queue every ${intervalSeconds}s. Ctrl-C to stop.\n`);

  for (;;) {
    try {
      for (const proposal of await api.listPending()) {
        if (seen.has(proposal.id)) continue;
        seen.add(proposal.id);
        console.log(`NEW PROPOSAL  id: ${proposal.id}`);
        console.log(renderProposal(proposal));
        console.log(`  Run: approval-bridge approve ${proposal.id}\n`);
      }
    } catch (err) {
      // A polling failure must not kill the watcher: the API restarting should
      // not require the operator to notice and restart this too.
      console.error(`  poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}
