// Exception desk wire shapes.
// Spec: docs/architecture.md §4.1, §7 phase 6

import { z } from "zod";
import { ExceptionStatus, ExceptionType } from "./enums.js";
import { IsoDateTime, Uuid } from "./primitives.js";

export const PlaybookStepStatus = z.enum(["PENDING", "IN_PROGRESS", "DONE", "SKIPPED"]);
export type PlaybookStepStatus = z.infer<typeof PlaybookStepStatus>;

/**
 * One step of a recovery playbook. Ordered, and stored as JSON on the case.
 *
 * The note is free text written by an operator during recovery, so it is
 * treated as potentially sensitive: it is not copied into evidence payloads,
 * which carry the step status only.
 */
export const PlaybookStep = z.object({
  step: z.string().min(1).max(200),
  status: PlaybookStepStatus,
  note: z.string().max(2000).optional(),
  completedAt: IsoDateTime.optional(),
});
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export const PlaybookSteps = z.array(PlaybookStep);
export type PlaybookSteps = z.infer<typeof PlaybookSteps>;

/** POST /exceptions */
export const CreateExceptionRequest = z.object({
  paymentRequestId: Uuid,
  type: ExceptionType,
  openedBy: z.string().min(1).max(100),
  note: z.string().max(2000).optional(),
});
export type CreateExceptionRequest = z.infer<typeof CreateExceptionRequest>;

/**
 * PATCH /exceptions/:id
 *
 * Steps are replaced wholesale rather than patched individually: the playbook
 * is an ordered list, and a partial update would let two operators interleave
 * writes and lose one of them.
 */
export const UpdateExceptionRequest = z
  .object({
    status: ExceptionStatus.optional(),
    playbookSteps: PlaybookSteps.optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.playbookSteps !== undefined,
    "provide at least one of status or playbookSteps",
  );
export type UpdateExceptionRequest = z.infer<typeof UpdateExceptionRequest>;

export const ExceptionSummary = z.object({
  id: Uuid,
  paymentRequestId: Uuid,
  type: ExceptionType,
  status: ExceptionStatus,
  playbookSteps: PlaybookSteps,
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type ExceptionSummary = z.infer<typeof ExceptionSummary>;
