// Exception case lifecycle.
//
// A case is opened when something has already gone wrong, so the record has to
// be usable months later by someone who was not there: the playbook says what
// was meant to happen, the step statuses say what actually did, and the
// evidence chain says why the payment was allowed in the first place.
//
// Spec: docs/architecture.md §4.1, §7 phase 6

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  CreateExceptionRequest,
  ExceptionStatus,
  ExceptionSummary,
  ExceptionType,
  PlaybookSteps,
  UpdateExceptionRequest,
} from "@cp/shared-types";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import type { EvidenceService, TxClient } from "../evidence/service.js";
import { playbookFor } from "./playbooks.js";

export type ExceptionServiceDeps = {
  prisma: PrismaClient;
  evidence: EvidenceService;
};

export class ExceptionService {
  constructor(private readonly deps: ExceptionServiceDeps) {}

  async open(input: CreateExceptionRequest): Promise<ExceptionSummary> {
    const payment = await this.deps.prisma.paymentRequest.findUnique({
      where: { id: input.paymentRequestId },
      include: { exceptionCase: true },
    });
    if (!payment) throw new NotFoundError(`Payment '${input.paymentRequestId}'`);
    if (payment.exceptionCase) {
      throw new ConflictError("An exception case is already open for this payment");
    }

    const created = await this.deps.prisma.$transaction(async (tx) => {
      const record = await this.createWithin(tx as unknown as TxClient & PrismaClient, input);
      return record;
    });

    return toSummary(created);
  }

  /**
   * Opens a case inside a caller's transaction.
   *
   * Used when a case is a consequence of another state change — a blocked
   * duplicate, say — so the payment status, the evidence and the case all
   * commit together or not at all (D07).
   */
  async createWithin(
    tx: PrismaClient | Prisma.TransactionClient,
    input: CreateExceptionRequest,
  ): Promise<Awaited<ReturnType<PrismaClient["exceptionCase"]["create"]>>> {
    const steps = playbookFor(input.type as ExceptionType);

    const record = await tx.exceptionCase.create({
      data: {
        paymentRequestId: input.paymentRequestId,
        type: input.type,
        playbookSteps: steps as unknown as Prisma.InputJsonValue,
      },
    });

    await this.deps.evidence.append(tx as unknown as TxClient, {
      eventType: "exception_opened",
      paymentRequestId: input.paymentRequestId,
      timestamp: new Date().toISOString(),
      data: { exceptionType: input.type, openedBy: input.openedBy },
    });

    return record;
  }

  async update(id: string, input: UpdateExceptionRequest): Promise<ExceptionSummary> {
    const existing = await this.deps.prisma.exceptionCase.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError(`Exception case '${id}'`);

    const terminal = existing.status === "RESOLVED" || existing.status === "WRITTEN_OFF";
    if (terminal) {
      // A closed case is part of the record. Reopening by mutation would erase
      // what was decided; a new case is the honest way to revisit it.
      throw new ConflictError(`Case is '${existing.status}' and cannot be modified`);
    }

    const status = input.status ?? existing.status;
    const resolving = status === "RESOLVED" || status === "WRITTEN_OFF";

    const updated = await this.deps.prisma.exceptionCase.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.playbookSteps
          ? { playbookSteps: input.playbookSteps as unknown as Prisma.InputJsonValue }
          : {}),
        ...(resolving && !existing.resolvedAt ? { resolvedAt: new Date() } : {}),
      },
    });

    return toSummary(updated);
  }

  async get(id: string): Promise<ExceptionSummary> {
    const record = await this.deps.prisma.exceptionCase.findUnique({ where: { id } });
    if (!record) throw new NotFoundError(`Exception case '${id}'`);
    return toSummary(record);
  }

  async list(status?: ExceptionStatus): Promise<ExceptionSummary[]> {
    const records = await this.deps.prisma.exceptionCase.findMany({
      ...(status ? { where: { status } } : {}),
      orderBy: { createdAt: "desc" },
    });
    return records.map(toSummary);
  }
}

function toSummary(record: {
  id: string;
  paymentRequestId: string;
  type: string;
  status: string;
  playbookSteps: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
}): ExceptionSummary {
  return {
    id: record.id,
    paymentRequestId: record.paymentRequestId,
    type: record.type as ExceptionType,
    status: record.status as ExceptionStatus,
    playbookSteps: record.playbookSteps as PlaybookSteps,
    createdAt: record.createdAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
  };
}
