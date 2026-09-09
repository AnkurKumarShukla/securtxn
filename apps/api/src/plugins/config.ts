// Makes the validated config available on the Fastify instance, so nothing else
// reads process.env directly.
// Spec: docs/architecture.md §9

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}

async function configPlugin(app: FastifyInstance, opts: { config: Config }): Promise<void> {
  app.decorate("config", opts.config);
}

export default fp(configPlugin, { name: "config" });
