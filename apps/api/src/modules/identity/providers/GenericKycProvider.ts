// Non-India identity provider (Persona / Onfido / Sumsub).
//
// Not implemented. It is a named class behind the real interface rather than a
// silent fallback, so selecting it fails loudly with 501 instead of letting a
// vendor through unverified (D21).
//
// Spec: docs/architecture.md §6

import { NotImplementedError } from "../../../lib/errors.js";
import type { IdentityProvider, IdentityResult, SessionStatus } from "../IdentityProvider.js";

export class GenericKycProvider implements IdentityProvider {
  async startSession(): Promise<{ sessionId: string; authorizationUrl: string }> {
    throw new NotImplementedError("Generic (non-India) KYC provider");
  }

  async getStatus(): Promise<{ status: SessionStatus; consented: string[] }> {
    throw new NotImplementedError("Generic (non-India) KYC provider");
  }

  async fetchIdentity(): Promise<IdentityResult> {
    throw new NotImplementedError("Generic (non-India) KYC provider");
  }
}
