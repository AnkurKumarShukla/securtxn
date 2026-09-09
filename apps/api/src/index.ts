// Process entrypoint: start the server, and shut it down cleanly.
//
// Graceful shutdown matters here beyond tidiness — an evidence record is written
// in the same transaction as the state change it records (D07). Dropping a
// connection mid-request rolls both back together, which is correct. Killing the
// process without draining does not guarantee that.
//
// Spec: docs/architecture.md §4.1

import { loadConfig } from "./config/index.js";
import { buildServer } from "./server.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    // Never hang forever waiting for an in-flight request to finish.
    const timer = setTimeout(() => {
      app.log.error("shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  // A rejection nobody handled has left state unknown. Log it and go down
  // rather than serving requests from a process in an undefined condition.
  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ reason }, "unhandled rejection");
    void shutdown("unhandledRejection");
  });

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  // The logger may not exist yet if config validation failed, so use stderr.
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
