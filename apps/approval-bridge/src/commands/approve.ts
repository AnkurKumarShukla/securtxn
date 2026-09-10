// `approval-bridge approve <id>` — the only path that can move money.

import type { ApiClient } from "../api-client.js";
import type { SigningTransport } from "../wallet-cli.js";
import { confirmSend, renderProposal } from "../prompts.js";

export async function approveCommand(
  api: ApiClient,
  transport: SigningTransport,
  proposalId: string,
  approverId: string,
): Promise<void> {
  // Re-read the queue rather than trusting an id from the command line: the
  // operator must confirm against what the API says NOW, not what a stale
  // terminal showed earlier.
  const proposals = await api.listPending();
  const proposal = proposals.find((p) => p.id === proposalId);

  if (!proposal) {
    throw new Error(`Proposal '${proposalId}' is not in the pending queue`);
  }

  console.log(renderProposal(proposal));

  if (!(await confirmSend(proposal))) {
    console.log("  Cancelled. Nothing was signed or sent.\n");
    return;
  }

  const result = await transport.send({
    to: proposal.address,
    amount: proposal.amount,
    token: proposal.token,
    network: proposal.network,
    settlementMode: proposal.settlementMode,
  });

  await api.reportSent(proposal.id, {
    txHash: result.txHash,
    ledgerConfirmedAt: result.confirmedAt.toISOString(),
    approverId,
  });

  console.log(`  Sent. tx: ${result.txHash}`);
  if (!result.broadcast) {
    // Said plainly every time. A synthetic hash that looks real is how a demo
    // accidentally claims a send that never happened.
    console.log(`  NOTE: transport '${result.transport}' did not broadcast — no on-chain transaction exists.`);
  }
  console.log("");
}
