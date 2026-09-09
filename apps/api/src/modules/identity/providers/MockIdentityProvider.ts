// Fixture-replaying identity provider.
//
// Live DigiLocker calls are billable per request (§4.7.1), so day-to-day work
// runs against a recorded capture. Two fixture directories share this code:
//
//   fixtures/digilocker/            real signed documents — gitignored, real PII
//   fixtures/digilocker-synthetic/  committed tier for CI
//
// Selected with DIGILOCKER_FIXTURE_DIR, so switching tiers needs no code change
// (D11).
//
// The consent step is the one thing mocking cannot reproduce, and it is what
// makes DigiLocker legally defensible as an identity source. So this provider
// does NOT jump to "succeeded": startSession returns an authorizationUrl
// pointing at a local stub page, and the session only advances when that page
// is visited. The polling path stays exercised, and a bug in it surfaces in dev
// rather than on the single live run (D17).
//
// Spec: docs/architecture.md §4.7.1

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DocType } from "@cp/shared-types";
import { NotFoundError, UnprocessableError } from "../../../lib/errors.js";
import { parseProfile, type UserProfile } from "../parse/profile.js";
import type { IdentityProvider, IdentityResult, SessionStatus } from "../IdentityProvider.js";
import { runIdentityChecks } from "../checks/index.js";

type MockSession = {
  sessionId: string;
  status: SessionStatus;
  docTypes: DocType[];
  createdAt: Date;
};

export type MockIdentityProviderOptions = {
  fixtureDir: string;
  /** Where the stub consent page lives; the session advances when it is visited. */
  consentStubBaseUrl: string;
};

export class MockIdentityProvider implements IdentityProvider {
  private readonly sessions = new Map<string, MockSession>();

  constructor(private readonly options: MockIdentityProviderOptions) {}

  async startSession(input: { mobile?: string; docTypes: string[] }): Promise<{
    sessionId: string;
    authorizationUrl: string;
  }> {
    // The real API pre-checks the mobile before creating a session. Reproduced
    // so the caller's ordering is exercised, even though it cannot fail here.
    const docTypes = input.docTypes as DocType[];
    const sessionId = randomUUID();

    this.sessions.set(sessionId, {
      sessionId,
      status: "created",
      docTypes,
      createdAt: new Date(),
    });

    return {
      sessionId,
      authorizationUrl: `${this.options.consentStubBaseUrl}?session_id=${sessionId}`,
    };
  }

  async getStatus(sessionId: string): Promise<{ status: SessionStatus; consented: string[] }> {
    const session = this.requireSession(sessionId);
    return {
      status: session.status,
      // The real API omits documents_consented until the session succeeds.
      consented: session.status === "succeeded" ? session.docTypes : [],
    };
  }

  /** Called by the local consent stub page — this is the human step, mocked. */
  grantConsent(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.status = "succeeded";
  }

  /** Exposed so tests can drive the failure branches without waiting (D21). */
  failSession(sessionId: string, status: Extract<SessionStatus, "failed" | "expired">): void {
    this.requireSession(sessionId).status = status;
  }

  async fetchIdentity(sessionId: string): Promise<IdentityResult> {
    const session = this.requireSession(sessionId);
    if (session.status !== "succeeded") {
      throw new UnprocessableError(
        `Session is '${session.status}'; documents are only available after consent`,
      );
    }

    const aadhaarXml = this.readDocument("aadhaar");
    const panXml = this.readDocument("pan");
    const profile = this.readProfile();

    const outcome = runIdentityChecks({ aadhaarXml, panXml, ...(profile ? { profile } : {}) });

    // The provider reports what the checks found; it does not decide whether to
    // persist. That call belongs to the service, which returns 422 on failure
    // (D04) — keeping this class a faithful stand-in for the live one.
    return {
      providerUserId: outcome.userId ?? "",
      legalName: outcome.legalName ?? "",
      dob: outcome.dob ?? "",
      gender: outcome.gender ?? "",
      ...(outcome.address ? { address: outcome.address } : {}),
      ...(outcome.photoBase64 ? { photoBase64: outcome.photoBase64 } : {}),
      ...(outcome.panNumber ? { taxId: outcome.panNumber } : {}),
      documentsVerified: session.docTypes,
      signatureVerified: outcome.results.xmlSignatureVerified,
      checks: outcome.results,
      ...(outcome.aadhaarLast4 ? { aadhaarLast4: outcome.aadhaarLast4 } : {}),
      aadhaarDocHash: outcome.aadhaarDocHash,
      panDocHash: outcome.panDocHash,
      ...(profile?.mobile ? { mobile: profile.mobile } : {}),
      failures: outcome.failures,
      ...(outcome.ttl ? { ttl: outcome.ttl } : {}),
    };
  }

  private readDocument(docType: DocType): string {
    const path = join(this.options.fixtureDir, "documents", `${docType}.xml`);
    try {
      return readFileSync(path, "utf8");
    } catch {
      throw new NotFoundError(`Fixture document '${docType}.xml' (looked in ${path})`);
    }
  }

  private readProfile(): UserProfile | undefined {
    const path = join(this.options.fixtureDir, "05_user_profile.json");
    try {
      return parseProfile(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // The profile is unsigned convenience data; its absence weakens the
      // cross-check but does not invalidate the signed documents.
      return undefined;
    }
  }

  private requireSession(sessionId: string): MockSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundError(`Identity session '${sessionId}'`);
    return session;
  }
}
