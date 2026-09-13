"use client";

// The state badge.
//
// Reads its colour from the one status map. Nothing else in the app may pick a
// status colour — that rule is the whole reason `status.ts` exists.

import type { ReactNode } from "react";
import { TONE, type Tone } from "./status";

export function StatusPill({
  tone,
  children,
  className = "",
}: {
  tone: Tone;
  children?: ReactNode | undefined;
  className?: string | undefined;
}) {
  const s = TONE[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-xs border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase ${s.bg} ${s.fg} ${s.edge} ${className}`}
    >
      {children ?? s.label}
    </span>
  );
}

/**
 * The decision verdict, at the size it deserves.
 *
 * `SAFE_TO_SEND` / `DO_NOT_SEND` / `REVERIFY` / `SEND_TEST_AMOUNT` is the
 * single most consequential value the API returns, and today it is only
 * visible inside a collapsed JSON blob. The code is kept verbatim in monospace
 * rather than prettified — a reviewer quoting it should be quoting the real
 * enum, not our paraphrase of it.
 */
export function Verdict({ decision, reason }: { decision: string; reason?: string | null }) {
  const tone: Tone =
    decision === "SAFE_TO_SEND"
      ? "ok"
      : decision === "DO_NOT_SEND"
        ? "failed"
        : "waiting"; // REVERIFY and SEND_TEST_AMOUNT both mean "a human decides"

  const s = TONE[tone];

  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${s.bg} ${s.edge}`}>
      <span className={`font-mono text-sm font-semibold tracking-tight ${s.fg}`}>{decision}</span>
      {reason && (
        <span className="font-mono text-[11px] text-mist-400">
          {reason}
        </span>
      )}
    </div>
  );
}
