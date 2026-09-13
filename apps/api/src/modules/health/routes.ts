// Liveness and readiness. Separate endpoints because they answer different
// questions: liveness says "restart me or not", readiness says "send me traffic
// or not". Collapsing them makes a database blip look like a dead process.

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const HealthResponse = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
  version: z.string(),
});

const ReadyResponse = z.object({
  status: z.enum(["ready", "degraded"]),
  checks: z.object({ database: z.enum(["up", "down"]) }),
});

const KeepAliveResponse = z.object({
  status: z.literal("awake"),
  uptimeSeconds: z.number(),
  /** What the pinger is keeping warm, so a stray request is self-explanatory. */
  purpose: z.literal("prevents the host idling this service to sleep"),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      // Liveness must stay cheap and always answerable, or a probe failure
      // triggers a restart loop during a traffic spike.
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Liveness — the process is running",
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      status: "ok" as const,
      uptimeSeconds: Math.round(process.uptime()),
      version: app.config.NODE_ENV,
    }),
  );

  app.get(
    "/health/keep-alive",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Keep-alive — pinged on a schedule so the host does not idle this out",
        description:
          "Separate from /health deliberately. Liveness is what the PLATFORM probes " +
          "to decide whether to restart the process; this is what a scheduled pinger " +
          "hits to stop a free-tier host putting the service to sleep. Sharing one " +
          "endpoint would mean a pinger outage looked like a liveness failure, and a " +
          "restart loop would look like a missed ping. " +
          "It touches nothing: no database, no chain, no external call. A keep-alive " +
          "that depended on Postgres would take the service down with it, which is " +
          "the opposite of keeping it up.",
        response: { 200: KeepAliveResponse },
      },
    },
    async () => ({
      status: "awake" as const,
      uptimeSeconds: Math.round(process.uptime()),
      purpose: "prevents the host idling this service to sleep" as const,
    }),
  );

  app.get(
    "/health/ready",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["health"],
        summary: "Readiness — dependencies are reachable",
        response: { 200: ReadyResponse, 503: ReadyResponse },
      },
    },
    async (_request, reply) => {
      let database: "up" | "down" = "up";
      try {
        await app.prisma.$queryRaw`SELECT 1`;
      } catch (err) {
        app.log.error({ err }, "readiness: database check failed");
        database = "down";
      }

      const ready = database === "up";
      return reply.status(ready ? 200 : 503).send({
        status: ready ? ("ready" as const) : ("degraded" as const),
        checks: { database },
      });
    },
  );
};

