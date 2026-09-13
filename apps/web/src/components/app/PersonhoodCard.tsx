"use client";

// The World ID enrolment, and what it is for.
//
// WHY THE NULLIFIER IS NOT PRINTED HERE, and it is not an oversight. A
// nullifier is a stable per-person identifier within an action: the same human
// always produces the same value for the same action, which is exactly what
// makes continuity checkable. It is also exactly what makes it correlating —
// anyone holding two of them can tell they belong to one person. No endpoint in
// this platform returns it, the evidence chain refuses to carry it, and the
// service keeps it only to compare against. Putting it on a screen would undo
// all three for a value nobody can act on.
//
// What IS worth showing is the fact it proves: an enrolment exists, later
// checks are measured against it, and the identifier for that enrolment is a
// per-vendor id that correlates with nothing.
//
// THE COPY IS CONSTRAINED. Selfie Check is medium assurance. Nothing here may
// say "identity verified" — it says a live human was confirmed and that later
// proofs are compared to this one.

import { StatusPill } from "../ui/StatusPill";
import { Panel } from "../ui/Surface";
import { Hash } from "../ui/Mono";
import { WORLD_ACTION, WORLD_ENVIRONMENT } from "../../lib/worldid";

export function PersonhoodCard({ enrolmentId }: { enrolmentId: string | null }) {
  const enrolled = Boolean(enrolmentId);

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-mono text-micro tracking-wide text-mist-500 uppercase">World ID</h2>
        <StatusPill tone={enrolled ? "ok" : "waiting"}>
          {enrolled ? "registered" : "not enrolled"}
        </StatusPill>
      </div>

      {enrolled ? (
        <>
          {/* <p className="text-2xs leading-relaxed text-mist-300">
            A live human was confirmed, and the nullifier that proof produced is recorded. Every
            later check on this account is compared against it — a different person signing with
            your key yields a different nullifier and is refused.
          </p> */}

          <div className="well mt-3 space-y-2 px-3 py-2.5">
            <Row k="Enrolment">
              <Hash value={enrolmentId!} chars={8} />
            </Row>
            <Row k="Action">
              <span className="font-mono text-2xs text-mist-400">{WORLD_ACTION}</span>
            </Row>
            <Row k="Environment">
              <span className="font-mono text-2xs text-mist-400">{WORLD_ENVIRONMENT}</span>
            </Row>
          </div>

          {/* <p className="mt-3 text-2xs leading-relaxed text-mist-500">
            The nullifier itself is never shown or sent anywhere. It is the same value for you
            every time, so anyone holding two of them could link you across payments — which is
            the correlation this is designed to prevent.
          </p> */}
        </>
      ) : (
        <p className="text-2xs leading-relaxed text-mist-500">
          Nothing is recorded for this account yet, so there is no earlier proof for a later one
          to be measured against. Complete the last step above.
        </p>
      )}
    </Panel>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="font-mono text-micro tracking-micro text-mist-600 uppercase">{k}</span>
      {children}
    </div>
  );
}
