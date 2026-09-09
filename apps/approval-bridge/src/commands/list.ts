// `approval-bridge list` — print the queue without signing anything.

import type { ApiClient } from "../api-client.js";
import { renderProposal } from "../prompts.js";

export async function listCommand(api: ApiClient): Promise<void> {
  const proposals = await api.listPending();

  if (proposals.length === 0) {
    console.log("No pending proposals.");
    return;
  }

  console.log(`${proposals.length} pending proposal(s):\n`);
  for (const proposal of proposals) {
    console.log(`  id: ${proposal.id}`);
    console.log(renderProposal(proposal));
  }
}
