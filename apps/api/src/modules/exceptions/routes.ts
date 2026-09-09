// Exception desk endpoints.
// Spec: docs/architecture.md §4.1, §7 phase 6

import {
  CreateExceptionRequest,
  ExceptionStatus,
  ExceptionSummary,
  UpdateExceptionRequest,
  Uuid,
} from "@cp/shared-types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EvidenceService } from "../evidence/service.js";
import { ExceptionService } from "./service.js";

const CaseParams = z.object({ id: Uuid });

export const exceptionRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ExceptionService({
    prisma: app.prisma,
    evidence: new EvidenceService(app.prisma),
  });

  app.post(
    "/exceptions",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["exceptions"],
        summary: "Open an exception case against a payment",
        description:
          "Seeds the recovery playbook for the exception type. One open case per " +
          "payment — a second finding belongs on the existing case, not beside it.",
        security: [{ bearerAuth: [] }],
        body: CreateExceptionRequest,
        response: { 201: ExceptionSummary },
      },
    },
    async (request, reply) => reply.status(201).send(await service.open(request.body)),
  );

  app.get(
    "/exceptions",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["exceptions"],
        summary: "List exception cases",
        security: [{ bearerAuth: [] }],
        querystring: z.object({ status: ExceptionStatus.optional() }),
        response: { 200: z.array(ExceptionSummary) },
      },
    },
    async (request) => service.list(request.query.status),
  );

  app.get(
    "/exceptions/:id",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["exceptions"],
        summary: "One exception case with its playbook",
        security: [{ bearerAuth: [] }],
        params: CaseParams,
        response: { 200: ExceptionSummary },
      },
    },
    async (request) => service.get(request.params.id),
  );

  app.patch(
    "/exceptions/:id",
    {
      preHandler: app.requireRole("agent"),
      schema: {
        tags: ["exceptions"],
        summary: "Advance playbook steps or change status",
        description:
          "Steps are replaced wholesale, so two operators cannot interleave partial " +
          "updates. A RESOLVED or WRITTEN_OFF case is part of the record and cannot " +
          "be modified.",
        security: [{ bearerAuth: [] }],
        params: CaseParams,
        body: UpdateExceptionRequest,
        response: { 200: ExceptionSummary },
      },
    },
    async (request) => service.update(request.params.id, request.body),
  );
};
