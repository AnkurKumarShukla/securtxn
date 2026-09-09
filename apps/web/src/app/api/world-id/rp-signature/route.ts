// Signs a World ID proof request server-side (integrate.md Step 3).
//
// WHY THIS MUST BE A SERVER ROUTE: the RP signing key is what proves a proof
// request came from our app. Signing on the client — or exposing the key as a
// NEXT_PUBLIC_* var — lets anyone forge requests in our name. The key is read
// here and nowhere else, and is never logged or returned.
//
// The portal returns the private key exactly once and cannot recover it;
// get_world_id_signing_key only ever returns the address. Rotating issues a new
// key and invalidates the old signer.

import { signRequest } from "@worldcoin/idkit-core/signing";

export const runtime = "nodejs"; // needs node crypto, not the edge runtime
export const dynamic = "force-dynamic"; // a nonce must never be cached

export async function POST(request: Request): Promise<Response> {
  const signingKeyHex = process.env.WORLD_RP_SIGNING_KEY;

  if (!signingKeyHex) {
    // Fail loudly rather than returning an unsigned request that would be
    // rejected later with a much less obvious error.
    return Response.json(
      { error: "WORLD_RP_SIGNING_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  let action: string;
  try {
    ({ action } = (await request.json()) as { action: string });
  } catch {
    return Response.json({ error: "expected a JSON body with an `action`" }, { status: 400 });
  }

  if (!action) return Response.json({ error: "`action` is required" }, { status: 400 });

  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex, action });

  // Field names are snake_case because that is what IDKit's rp_context expects.
  return Response.json({ sig, nonce, created_at: createdAt, expires_at: expiresAt });
}
