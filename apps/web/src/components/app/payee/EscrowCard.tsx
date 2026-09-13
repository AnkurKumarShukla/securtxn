"use client";

// Money locked for this payee, and the act of collecting it.
//
// THE REVEAL IS THE RECEIPT. The escrow pays out to whoever presents the
// preimage, so the claim has to be sent by the payee themselves — which is why
// this button signs with the key in this browser rather than asking a server to
// do it. And if they never claim, the money returns to the sender, which makes
// the timelock a deadline worth showing as one rather than as an ISO string.

import { until } from "../../../lib/format";
import type { Escrow, PayeeFlow } from "../../../hooks/usePayeeFlow";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { StatusPill } from "../../ui/StatusPill";
import type { Tone } from "../../ui/status";

/** The four things claiming does, in the order `lib/claim.ts` reports them. */
const CLAIM_STAGES = [
  "signing the secret release…",
  "requesting the preimage…",
  "claiming on chain…",
  "recording the claim…",
];

export function EscrowCard({ escrow, flow }: { escrow: Escrow; flow: PayeeFlow }) {
  const claiming = flow.busy === `claim ${escrow.paymentRequestId}`;
  const stage = flow.claimStage[escrow.paymentRequestId];
  const stageIndex = stage ? CLAIM_STAGES.indexOf(stage) : -1;

  const tone: Tone =
    escrow.status === "CLAIMED"
      ? "ok"
      : escrow.status === "REFUNDED"
        ? "skipped"
        : escrow.status === "LOCKED"
          ? "waiting"
          : "idle";

  const refundsIn = until(escrow.timelock);

  return (
    <div className="well p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[22px] font-semibold tracking-tight tabular-nums text-mist-50">
          {escrow.amount}
        </span>
        <StatusPill tone={tone}>{escrow.status.toLowerCase()}</StatusPill>
      </div>

      <div className="mt-3">
        <Field k="Escrow" v={escrow.escrowAddress} mono copy />
        <Field
          k="Refunds after"
          v={refundsIn ? `${escrow.timelock} · ${refundsIn}` : escrow.timelock}
          tone={refundsIn === "elapsed" ? "halt" : undefined}
          hint="If nobody claims before this, the money returns to the sender automatically."
        />
        {escrow.claimTxHash && <Field k="Claim tx" v={escrow.claimTxHash} mono copy />}
      </div>

      {escrow.status === "LOCKED" ? (
        <>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => void flow.claim(escrow)}
            disabled={flow.busy !== null && !claiming}
            busy={claiming}
          >
            {claiming ? "Claiming…" : "Claim the money"}
          </Button>

          {/* The four stages were always reported through `claim.ts`'s callback;
              they just landed in the activity log while the button said
              "Claiming…". Stage three waits on a transaction receipt and is the
              long one. */}
          {claiming && (
            <ol className="mt-3 space-y-1">
              {CLAIM_STAGES.map((label, i) => {
                const state =
                  stageIndex > i ? "done" : stageIndex === i ? "active" : "pending";
                return (
                  <li key={label} className="flex items-center gap-2 text-[11.5px]">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        state === "done"
                          ? "bg-verified-400"
                          : state === "active"
                            ? "bg-signal-400 motion-safe:animate-[breathe_1.8s_ease-in-out_infinite]"
                            : "bg-white/15"
                      }`}
                    />
                    <span
                      className={
                        state === "pending"
                          ? "text-mist-600"
                          : state === "active"
                            ? "text-signal-300"
                            : "text-mist-400"
                      }
                    >
                      {label}
                    </span>
                    {state === "active" && i === 2 && (
                      <span className="text-mist-600">waiting for the receipt</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

        </>
      ) : (
        <p className="mt-3 text-[11.5px] leading-relaxed text-mist-500">
          {escrow.status === "CLAIMED"
            ? "Claimed — the money is yours."
            : `Escrow is ${escrow.status}.`}
        </p>
      )}
    </div>
  );
}
