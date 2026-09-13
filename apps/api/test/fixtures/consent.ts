// Walking a payment through P3-P4 the way a real payee would.
//
// Every suite that reaches a decision now has to pass consent first, because
// `runDecision` refuses without it. That is the point of the control, so the
// helper does NOT bypass it: it requests consent over HTTP and signs the
// acceptance with the payee's actual key. A shortcut that wrote a PayeeConsent
// row directly would let the suite keep passing if the signature check broke.

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  buildPayeeConsentMessage,
  domainFor,
  PAYEE_CONSENT_TYPES,
} from "../../src/lib/eip712.js";
import { enrolSubject, passPayeeCheck, passSenderCheck } from "./worldid.js";

export type ConsentOptions = {
  /** Overrides the signer, to test that a foreign key is refused. */
  signer?: PrivateKeyAccount;
  /** The World ID verification id, when the risk engine demands one (P5). */
  worldIdVerificationId?: string;
};

/**
 * Requests consent and accepts it. Returns the raw responses so a caller can
 * assert on either leg.
 *
 * `amount`, `token` and `invoiceRef` are read back from the consent prompt
 * rather than passed in: the payee signs what the SERVER says the payment is,
 * which is exactly the property the signature is supposed to have.
 */
export async function acceptPayment(
  app: FastifyInstance,
  paymentId: string,
  payee: PrivateKeyAccount,
  auth: () => Record<string, string>,
  options: ConsentOptions = {},
) {
  const requested = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/request-consent`,
    headers: auth(),
  });

  const prompt = await app.inject({
    method: "GET",
    url: `/payments/${paymentId}/consent-prompt`,
    headers: auth(),
  });
  const shown = prompt.json();

  const signer = options.signer ?? payee;
  const signature = await signer.signTypedData({
    domain: domainFor(chainIdOf(app)),
    types: PAYEE_CONSENT_TYPES,
    primaryType: "PayeeConsent",
    message: buildPayeeConsentMessage({
      paymentRequestId: paymentId,
      payeeAddress: shown.payeeAddress,
      amount: shown.amount,
      token: shown.token,
      invoiceRef: shown.invoiceRef,
    }),
  });

  const accepted = await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/consent`,
    payload: {
      decision: "ACCEPTED",
      signature,
      signerAddress: signer.address,
      ...(options.worldIdVerificationId
        ? { worldIdVerificationId: options.worldIdVerificationId }
        : {}),
    },
  });

  return { requested, prompt, accepted };
}

/** The denial leg. No signature: refusing needs no proof. */
export async function denyPayment(
  app: FastifyInstance,
  paymentId: string,
  auth: () => Record<string, string>,
) {
  await app.inject({
    method: "POST",
    url: `/payments/${paymentId}/request-consent`,
    headers: auth(),
  });
  return app.inject({
    method: "POST",
    url: `/payments/${paymentId}/consent`,
    payload: { decision: "DENIED" },
  });
}

function chainIdOf(app: FastifyInstance): number {
  return (app as unknown as { config: { HEDERA_CHAIN_ID: number } }).config.HEDERA_CHAIN_ID;
}

/**
 * The whole payee leg, for suites that are testing something downstream of it.
 *
 * A first payment between two parties ALWAYS trips the P5 challenge, so almost
 * every test payment needs a World ID check to get past consent. This satisfies
 * that challenge rather than disabling it: the rows it writes are the same rows
 * a real check produces, and the service still validates their signal, purpose
 * and subject. A helper that turned the risk engine off instead would leave the
 * suites passing whether or not the gate works.
 *
 * Returns the acceptance response so a caller can still assert on it.
 */
export async function consentToPayment(
  app: FastifyInstance,
  prisma: PrismaClient,
  paymentId: string,
  payeeVendorId: string,
  payee: PrivateKeyAccount,
  auth: () => Record<string, string>,
) {
  // P2 first: the payee is not asked anything until the SENDER has proved
  // they are a live human raising this specific payment.
  const payment = await prisma.paymentRequest.findUniqueOrThrow({
    where: { id: paymentId },
    select: { payerVendorId: true },
  });
  if (payment.payerVendorId) {
    await passSenderCheck(prisma, payment.payerVendorId, paymentId);
  }

  const enrolled = await prisma.worldIdVerification.findFirst({
    where: { subject: payeeVendorId, purpose: "ENROLLMENT" },
    select: { id: true },
  });
  if (!enrolled) await enrolSubject(prisma, payeeVendorId);

  const worldIdVerificationId = await passPayeeCheck(prisma, payeeVendorId, paymentId);
  const { accepted } = await acceptPayment(app, paymentId, payee, auth, {
    worldIdVerificationId,
  });
  return accepted;
}
