// Verifying a World ID proof against the World verifier (integrate.md Step 5).
//
// Injected rather than imported so tests can drive every branch without hitting
// the live verifier — the same reason the vendor lookup and the CRE matcher are
// injected (D09). The HTTP implementation is the only thing that talks to
// World; everything downstream works off the parsed result.

/** The shape IDKit returns. Forwarded upstream verbatim — never remapped. */
export type IdKitProof = {
  action?: string;
  environment?: string;
  protocol_version?: string;
  responses?: { identifier?: string; nullifier?: string; signal_hash?: string }[];
};

export type WorldIdVerification = {
  nullifierHex: string;
  /**
   * The signal the proof was actually bound to, as a field-element hash.
   *
   * The v4 verify endpoint never learns which signal WE expected — the v3 API
   * took it explicitly (`verifyCloudProof(proof, app_id, action, signal)`), v4
   * does not. So World confirms the proof is valid for whatever signal_hash is
   * inside it, and confirming that is the signal we asked for is OUR job. It is
   * surfaced here so the service can compare it (D49b).
   */
  signalHash: string;
  /** "selfie" for Selfie Check, "proof_of_human" for Orb, etc. */
  credential: string;
  action: string;
  environment: string;
  /**
   * The verifier flagged this nullifier as previously seen.
   *
   * DIAGNOSTIC ONLY. World returns `success: true` and HTTP 200 on reuse — it
   * annotates, it does not reject (observed: "Proof verified successfully
   * (nullifier reuse)", D49a). Anything gating on upstream success alone would
   * let one person approve the same payment indefinitely. The database's unique
   * index is the control; this field is for humans reading an audit trail.
   */
  upstreamReuse: boolean;
};

export class WorldIdVerificationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WorldIdVerificationError";
  }
}

export interface WorldIdProofVerifier {
  verify(proof: IdKitProof): Promise<WorldIdVerification>;
}

export type HttpWorldIdProofVerifierOptions = {
  rpId: string;
  /** Overridable so tests never reach the network. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://developer.world.org/api/v4/verify";

export class HttpWorldIdProofVerifier implements WorldIdProofVerifier {
  constructor(private readonly options: HttpWorldIdProofVerifierOptions) {}

  async verify(proof: IdKitProof): Promise<WorldIdVerification> {
    const baseUrl = this.options.baseUrl ?? DEFAULT_BASE_URL;
    const doFetch = this.options.fetchImpl ?? fetch;

    // Forwarded EXACTLY as IDKit returned it. Re-encoding, reordering or
    // trimming any field invalidates the signature over it.
    const response = await doFetch(`${baseUrl}/${this.options.rpId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new WorldIdVerificationError(
        `World ID verifier rejected the proof: ${text.slice(0, 300)}`,
        response.status,
      );
    }

    const body = JSON.parse(text) as {
      success?: boolean;
      nullifier?: string;
      action?: string;
      environment?: string;
      message?: string;
      results?: { identifier?: string; nullifier?: string; success?: boolean }[];
    };

    // A 200 that is not a success is still a rejection. Trusting the status
    // code alone would accept whatever the body said.
    if (body.success !== true) {
      throw new WorldIdVerificationError(`World ID verification failed: ${text.slice(0, 300)}`);
    }

    const result = body.results?.[0];
    const nullifierHex = body.nullifier ?? result?.nullifier;

    if (!nullifierHex) {
      // Without a nullifier there is no replay protection and no continuity —
      // accepting the proof anyway would look verified and protect nothing.
      throw new WorldIdVerificationError("World ID response carried no nullifier");
    }

    return {
      nullifierHex,
      signalHash: proof.responses?.[0]?.signal_hash ?? "",
      credential: result?.identifier ?? proof.responses?.[0]?.identifier ?? "unknown",
      action: body.action ?? proof.action ?? "",
      environment: body.environment ?? proof.environment ?? "",
      upstreamReuse: /nullifier reuse/i.test(body.message ?? ""),
    };
  }
}
