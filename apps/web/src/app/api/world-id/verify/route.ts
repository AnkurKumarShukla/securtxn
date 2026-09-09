// Verifies a World ID proof server-side (integrate.md Step 5).
//
// WHY SERVER-SIDE: a client can return any JSON it likes. Only the World
// verifier, called from a trusted server, confirms a proof is real and tied to
// a genuine credential. Verifying in the browser defeats the entire point.
//
// The payload is forwarded EXACTLY as IDKit returned it — no remapping, no
// re-encoding, no trimming. Mutating it invalidates the signature.
//
// NOTE ON SCOPE: this is the test surface. Production still owes Step 6 —
// persisting the nullifier as NUMERIC(78,0) with UNIQUE(nullifier, action), so
// the same person cannot verify the same action twice. Without that there is no
// replay protection at all, so this route deliberately says so in its response
// rather than implying the check is complete.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERIFY_BASE = "https://developer.world.org/api/v4/verify";

export async function POST(request: Request): Promise<Response> {
  const rpId = process.env.NEXT_PUBLIC_WORLD_RP_ID;
  if (!rpId) {
    return Response.json({ error: "NEXT_PUBLIC_WORLD_RP_ID is not configured" }, { status: 500 });
  }

  const idkitResult = await request.json();

  const response = await fetch(`${VERIFY_BASE}/${rpId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(idkitResult),
  });

  const body = await response.text();

  // The upstream body is returned verbatim on failure. During integration the
  // exact verifier error is the whole diagnostic value; collapsing it to
  // "verification failed" is what makes these flows hard to debug.
  if (!response.ok) {
    return Response.json(
      { verified: false, upstream_status: response.status, upstream_body: body },
      { status: 400 },
    );
  }

  return Response.json({
    verified: true,
    upstream: safeJson(body),
    nullifier_persisted: false,
    note: "Test surface: the nullifier is NOT yet persisted, so replay is not prevented here.",
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
