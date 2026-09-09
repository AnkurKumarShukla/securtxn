// Prisma client as a Fastify plugin: one connection pool per process, closed on
// shutdown so the container does not leak sessions across restarts.
// Spec: docs/architecture.md §3

import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function prismaPlugin(app: FastifyInstance): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: app.config.DATABASE_URL } },
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });

  prisma.$on("warn", (e) => app.log.warn({ target: e.target }, e.message));
  prisma.$on("error", (e) => app.log.error({ target: e.target }, e.message));

  // Fail at boot rather than on the first request, so a bad DATABASE_URL is a
  // startup error and not an intermittent 500.
  await prisma.$connect();

  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
}

export default fp(prismaPlugin, { name: "prisma", dependencies: ["config"] });
