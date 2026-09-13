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
import { payeeSignal, senderSignal } from "../../src/modules/consent/service.js";

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
 * P2/P5 — a later check bound to one payment AND to one side of it.
 *
 * The signal is role-qualified ("sender:<id>" / "payee:<id>"), not the bare
 * payment id. Two reasons, and the second is why this helper takes the role
 * rather than letting each caller spell the string:
 *
 *  - the uniqueness index is (nullifier, action, signal), so one human paying
 *    themselves — which is exactly the demo — would collide with their own
 *    sender check when acting as payee;
 *  - the qualifiers are the service's, imported from it, so a change there
 *    breaks these tests loudly instead of leaving them asserting a signal the
 *    real code stopped producing.
 */
async function passCheck(
  prisma: PrismaClient,
  subject: string,
  signal: string,
): Promise<string> {
  const row = await prisma.worldIdVerification.create({
    data: {
      nullifier: new Prisma.Decimal(nullifierFor(subject)),
      action: ACTION,
      signal,
      credential: "selfie",
      environment: "staging",
      subject,
      purpose: "REVERIFICATION",
    },
    select: { id: true },
  });
  return row.id;
}

/** P2 — the sender's unconditional check for this payment. */
export async function passSenderCheck(
  prisma: PrismaClient,
  subject: string,
  paymentId: string,
): Promise<string> {
  return passCheck(prisma, subject, senderSignal(paymentId));
}

/** P5 — the payee's check, demanded only when the risk engine asks for one. */
export async function passPayeeCheck(
  prisma: PrismaClient,
  subject: string,
  paymentId: string,
): Promise<string> {
  return passCheck(prisma, subject, payeeSignal(paymentId));
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
