// Live DigiLocker client, via the Sandbox aggregator.
//
// EVERY call except /authenticate and /status is BILLED per request (§4.7.1).
// Build and debug against MockIdentityProvider; reach for this one to confirm,
// not to iterate.
//
// The call sequence is the one verified end-to-end on 2026-09-08, and the human
// consent step in the middle cannot be automated — which is precisely what
// makes DigiLocker defensible as an identity source.
//
// Spec: docs/architecture.md §4.7

import type { DocType } from "@cp/shared-types";
import { AppError, UnprocessableError } from "../../../lib/errors.js";
import { parseProfile, type UserProfile } from "../parse/profile.js";
import { runIdentityChecks } from "../checks/index.js";
import type { IdentityProvider, IdentityResult, SessionStatus } from "../IdentityProvider.js";

export type DigiLockerProviderOptions = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Carries the vendor's onboardingSessionNonce in its state (D03). */
  redirectUrl: string;
  /** Guards against a hung aggregator holding a request open. */
  requestTimeoutMs?: number;
};

type TokenCache = { token: string; expiresAt: number };

const API_VERSION = "1.0.0";
/** Tokens are valid 24h; refresh early so a request never races expiry. */
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;

export class DigiLockerProvider implements IdentityProvider {
  private tokenCache: TokenCache | null = null;

  constructor(private readonly options: DigiLockerProviderOptions) {}

  /**
   * Pre-check before creating a session. Billable, but far cheaper than the
   * dead sessions it avoids.
   *
   * `mobile` is prefill only — there is no way to retrieve anyone's documents
   * by phone number. Consent is mandatory.
   */
  async userExists(mobile: string): Promise<boolean> {
    const body = await this.post<{ user_exists: boolean }>("/kyc/digilocker/user/verify", {
      "@entity": "in.co.sandbox.kyc.digilocker.user.verification.request",
      mobile,
    });
    return body.user_exists === true;
  }

  async startSession(input: { mobile?: string; docTypes: string[] }): Promise<{
    sessionId: string;
    authorizationUrl: string;
  }> {
    const body = await this.post<{ session_id: string; authorization_url: string }>(
      "/kyc/digilocker/sessions/init",
      {
        "@entity": "in.co.sandbox.kyc.digilocker.session.request",
        flow: "signin",
        redirect_url: this.options.redirectUrl,
        doc_types: input.docTypes,
        options: {
          verification_method: ["aadhaar"],
          pinless: true,
          ...(input.mobile ? { verified_mobile: input.mobile } : {}),
        },
      },
    );

    return { sessionId: body.session_id, authorizationUrl: body.authorization_url };
  }

  async getStatus(sessionId: string): Promise<{ status: SessionStatus; consented: string[] }> {
    // Not billable — safe to poll.
    const body = await this.get<{ status: string; documents_consented?: string[] }>(
      `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/status`,
    );

    return {
      status: normaliseStatus(body.status),
      consented: body.documents_consented ?? [],
    };
  }

  async fetchIdentity(sessionId: string): Promise<IdentityResult> {
    // What the human ACTUALLY granted, checked before fetching anything.
    //
    // A partial consent — Aadhaar granted, PAN not — otherwise surfaces as an
    // opaque "documents/pan failed with HTTP 400" from the aggregator, which
    // says nothing about what to do. It also wastes a billed document call on a
    // request that cannot succeed.
    //
    // `/status` is one of the two endpoints that is NOT billed, so this costs
    // nothing, and the list of document TYPES is not identity data (D06).
    const { consented } = await this.getStatus(sessionId);
    const missing = (["aadhaar", "pan"] as const).filter((doc) => !consented.includes(doc));
    if (missing.length > 0) {
      throw new UnprocessableError(
        `DigiLocker consent is missing: ${missing.join(", ")}. ` +
          `Granted: ${consented.join(", ") || "nothing"}. ` +
          "Both Aadhaar and PAN are required — the PAN is what the payee match compares. " +
          "Start the identity step again and tick BOTH documents on the DigiLocker screen. " +
          "If PAN is not offered there, that DigiLocker account has no PAN linked to it.",
      );
    }

    const [aadhaarXml, panXml, profile] = await Promise.all([
      this.fetchDocument(sessionId, "aadhaar"),
      this.fetchDocument(sessionId, "pan"),
      this.fetchProfile(sessionId),
    ]);

    const outcome = runIdentityChecks({ aadhaarXml, panXml, ...(profile ? { profile } : {}) });

    return {
      providerUserId: outcome.userId ?? "",
      legalName: outcome.legalName ?? "",
      dob: outcome.dob ?? "",
      gender: outcome.gender ?? "",
      ...(outcome.address ? { address: outcome.address } : {}),
      ...(outcome.photoBase64 ? { photoBase64: outcome.photoBase64 } : {}),
      ...(outcome.panNumber ? { taxId: outcome.panNumber } : {}),
      documentsVerified: ["aadhaar", "pan"] satisfies DocType[],
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

  private async fetchProfile(sessionId: string): Promise<UserProfile | undefined> {
    try {
      const body = await this.get<unknown>(
        `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/user/profile`,
      );
      return parseProfile(body);
    } catch {
      // Unsigned convenience data. Its absence weakens the cross-check but does
      // not invalidate the signed documents, so it must not fail the flow.
      return undefined;
    }
  }

  /**
   * Documents come back as a short-lived presigned S3 URL, not inline.
   * Download immediately and never persist the URL — it expires in minutes.
   */
  private async fetchDocument(sessionId: string, docType: DocType): Promise<string> {
    const body = await this.get<{ files?: { url?: string }[] }>(
      `/kyc/digilocker/sessions/${encodeURIComponent(sessionId)}/documents/${docType}`,
    );

    const url = body.files?.[0]?.url;
    if (!url) {
      throw new UnprocessableError(`DigiLocker returned no file URL for '${docType}'`);
    }

    const response = await this.withTimeout((signal) => fetch(url, { signal }));
    if (!response.ok) {
      throw new AppError(502, "IDENTITY_PROVIDER_ERROR", `Could not download the ${docType} document`);
    }
    return response.text();
  }

  // --- transport ----------------------------------------------------------

  /**
   * /authenticate is not billable, so refreshing eagerly costs nothing while
   * an expired token mid-flow would waste a billed call.
   */
  private async accessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) return this.tokenCache.token;

    const response = await this.withTimeout((signal) =>
      fetch(`${this.options.baseUrl}/authenticate`, {
        method: "POST",
        signal,
        headers: {
          "x-api-key": this.options.apiKey,
          "x-api-secret": this.options.apiSecret,
          "x-api-version": API_VERSION,
        },
      }),
    );

    const body = (await this.readJson(response, "/authenticate")) as { access_token?: string };
    if (!body.access_token) {
      throw new AppError(502, "IDENTITY_PROVIDER_ERROR", "DigiLocker authentication returned no token");
    }

    this.tokenCache = { token: body.access_token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return body.access_token;
  }

  /**
   * Authenticated request headers.
   *
   * UNVERIFIED AGAINST LIVE: only the /authenticate headers were captured on
   * 2026-09-08. This follows the aggregator's documented convention (bearer
   * token plus the api key). Confirm on the first live run — a 401 here is far
   * more likely to be a header shape than a bad credential.
   */
  private async authHeaders(): Promise<Record<string, string>> {
    return {
      authorization: await this.accessToken(),
      "x-api-key": this.options.apiKey,
      "x-api-version": API_VERSION,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.withTimeout((signal) =>
      this.authHeaders().then((headers) =>
        fetch(`${this.options.baseUrl}${path}`, { method: "GET", headers, signal }),
      ),
    );
    return (await this.readJson(response, path)) as T;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const response = await this.withTimeout((signal) =>
      this.authHeaders().then((headers) =>
        fetch(`${this.options.baseUrl}${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        }),
      ),
    );
    return (await this.readJson(response, path)) as T;
  }

  /** Unwraps the `{ code, data, transaction_id }` envelope every route returns. */
  private async readJson(response: Response, path: string): Promise<unknown> {
    const text = await response.text();

    if (!response.ok) {
      // `data` can echo submitted identity data and never leaves this method
      // (D06). The ENVELOPE around it cannot: `code`, `message` and
      // `transaction_id` are the aggregator's own status fields.
      //
      // Withholding those cost a long debugging session — an "Insufficient
      // credits" quota failure surfaced as a bare "HTTP 403", which reads like
      // a permissions problem with the user's documents and sent us looking at
      // the wrong end of the system entirely. A status code is not a secret,
      // and the transaction id is what support asks for first.
      throw new AppError(
        response.status === 429 ? 429 : 502,
        "IDENTITY_PROVIDER_ERROR",
        `DigiLocker ${path} failed with HTTP ${response.status}${describeFailure(text)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError(502, "IDENTITY_PROVIDER_ERROR", `DigiLocker ${path} returned non-JSON`);
    }

    const envelope = parsed as { data?: unknown };
    return envelope.data ?? parsed;
  }

  private async withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Anything unrecognised is treated as failed, never as success. */
function normaliseStatus(status: string): SessionStatus {
  switch (status) {
    case "created":
    case "succeeded":
    case "failed":
    case "expired":
      return status;
    default:
      return "failed";
  }
}

/**
 * The envelope's status fields, for an error message. Never `data`.
 *
 * Deliberately picks named fields rather than filtering a blob: a denylist
 * would leak whatever the aggregator adds next, an allowlist cannot.
 */
function describeFailure(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      transaction_id?: unknown;
    };
    const message = typeof parsed.message === "string" ? parsed.message.slice(0, 200) : null;
    const txn = typeof parsed.transaction_id === "string" ? parsed.transaction_id : null;
    if (!message && !txn) return "";
    return ` — ${message ?? "no message"}${txn ? ` (transaction ${txn})` : ""}`;
  } catch {
    // A non-JSON body is usually a gateway or proxy page; its content is not
    // ours and may be anything, so it is not repeated.
    return "";
  }
}
