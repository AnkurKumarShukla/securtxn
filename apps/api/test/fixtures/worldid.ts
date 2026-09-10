// World ID rows for suites that are not testing World ID.
//
// WHY DIRECT INSERTION IS LEGITIMATE HERE. Producing a real proof needs the
// World app and a human face; `world-id-routes.test.ts` covers the verifier
// path against a recorded live capture, including that a proof from a
// different human is refused. The suites using THIS helper are testing
// something else — that consent will not be accepted unless a valid check
// exists — so what they need is a row with the right shape, not a second copy
// of the verification tests.
//
// The one thing the helper is careful about: it reuses ONE nullifier per
// subject across enrolment and later checks, because that is what "the same
// human" means in this system. A helper that minted a fresh nullifier each
// time would quietly model a different person every call and no continuity
// bug would ever be caught.

import { Prisma, type PrismaClient } from "@prisma/client";
import { loadConfig } from "../../src/config/index.js";

/**
 * The action the service itself uses, read from config rather than repeated.
 * A nullifier is action-scoped: a helper hardcoding a different string would
 * write rows the real code could never have produced.
 */
const ACTION = loadConfig().WORLD_ACTION;

const nullifiers = new Map<string, string>();

function nullifierFor(subject: string): string {
  const existing = nullifiers.get(subject);
  if (existing) return existing;
  // A 40-digit decimal: comfortably inside the Decimal(78, 0) column and far
  // enough apart that two subjects in one run cannot collide.
  const value = `${Date.now()}${Math.floor(Math.random() * 1e12)}`.padEnd(40, "7");
  nullifiers.set(subject, value);
  return value;
}

/** O7 — the enrolment every later check is compared against. */
export async function enrolSubject(
  prisma: PrismaClient,
  subject: string,
  signal = `onboarding-${subject}`,
): Promise<string> {
  const row = await prisma.worldIdVerification.create({
    data: {
      nullifier: new Prisma.Decimal(nullifierFor(subject)),
      action: ACTION,
      signal,
      credential: "selfie",
      environment: "staging",
      subject,
      purpose: "ENROLLMENT",
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * P2/P5 — a later check bound to one payment.
 *
 * `signal` is the payment id, which is what makes the check non-transferable:
 * the consent path rejects a verification whose signal names a different
 * payment.
 */
export async function passWorldIdCheck(
  prisma: PrismaClient,
  subject: string,
  paymentId: string,
): Promise<string> {
  const row = await prisma.worldIdVerification.create({
    data: {
      nullifier: new Prisma.Decimal(nullifierFor(subject)),
      action: ACTION,
      signal: paymentId,
      credential: "selfie",
      environment: "staging",
      subject,
      purpose: "REVERIFICATION",
    },
    select: { id: true },
  });
  return row.id;
}

/** Removes every row this helper created for the given subjects. */
export async function clearWorldIdRows(
  prisma: PrismaClient,
  subjects: string[],
): Promise<void> {
  if (subjects.length === 0) return;
  await prisma.worldIdVerification.deleteMany({ where: { subject: { in: subjects } } });
  for (const subject of subjects) nullifiers.delete(subject);
}
