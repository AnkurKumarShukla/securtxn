// approval-bridge CLI.
//
// Runs on the APPROVER'S machine. It is the only process in this system that
// can move money, and it reaches the platform over HTTP with a role-scoped
// token — it imports nothing from apps/api (D12).
//
// Spec: docs/architecture.md §4.3

import { Command } from "commander";
import { ApiClient } from "./api-client.js";
import { loadBridgeConfig } from "./config.js";
import { approveCommand } from "./commands/approve.js";
import { listCommand } from "./commands/list.js";
import { watchCommand } from "./commands/watch.js";
import { promptPassword } from "./prompts.js";
import { createTransport } from "./wallet-cli.js";

const program = new Command();

program
  .name("approval-bridge")
  .description("Human approval bridge for Confirmed Payee. Signing happens here and nowhere else.")
  .version("0.1.0");

program
  .command("list")
  .description("Show the pending approval queue")
  .action(async () => {
    const config = loadBridgeConfig();
    await listCommand(new ApiClient(config));
  });

program
  .command("approve")
  .argument("<proposalId>")
  .option("--approver <id>", "operator identity recorded against the approval", "local-operator")
  .description("Confirm and send one proposal")
  .action(async (proposalId: string, options: { approver: string }) => {
    const config = loadBridgeConfig();
    const transport = createTransport(config, promptPassword);

    console.log(`  transport: ${transport.kind}`);
    await approveCommand(new ApiClient(config), transport, proposalId, options.approver);
  });

program
  .command("watch")
  .description("Poll the queue and print new proposals (never approves)")
  .action(async () => {
    const config = loadBridgeConfig();
    await watchCommand(new ApiClient(config), config.POLL_INTERVAL_SECONDS);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
