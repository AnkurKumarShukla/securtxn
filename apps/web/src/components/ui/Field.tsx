"use client";

// The key-value row.
//
// This was defined twice, byte for byte, at the bottom of `console/page.tsx`
// and `payee/page.tsx`. Both copies rendered a label, a value, an em-dash for
// null and an optional copy glyph — and both would have had to be edited in
// lockstep for the rest of the revamp. One definition now.
//
// The API contract is unchanged: `k`, `v`, `mono` and `copy` behave exactly as
// they did. `hint` and `tone` are additions, and both are optional.

import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { Tooltip } from "./Tooltip";

export function Field({
  k,
  v,
  mono,
  copy,
  hint,
  tone,
}: {
  // `| undefined` on every optional: the project runs with
  // exactOptionalPropertyTypes, so "present but undefined" and "absent" are
  // different types — and callers pass computed values straight through.
  k: string;
  v: string | null | undefined;
  mono?: boolean | undefined;
  copy?: boolean | undefined;
  /** Explains what the value is for. Shown on hover over the label. */
  hint?: ReactNode | undefined;
  /** Colours the value. Use only where the value itself is a verdict. */
  tone?: "ok" | "warn" | "halt" | undefined;
}) {
  const valueColour =
    tone === "ok"
      ? "text-verified-400"
      : tone === "warn"
        ? "text-pending-400"
        : tone === "halt"
          ? "text-halt-400"
          : "text-mist-200";

  return (
    <div className="flex items-center justify-between gap-3 hairline-b py-1.5 text-[12.5px] last:border-b-0">
      {hint ? (
        <Tooltip content={hint}>
          <span className="shrink-0 cursor-help text-mist-500 underline decoration-dotted decoration-mist-600/60 underline-offset-4">
            {k}
          </span>
        </Tooltip>
      ) : (
        <span className="shrink-0 text-mist-500">{k}</span>
      )}

      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={`min-w-0 text-right break-all ${valueColour} ${mono ? "font-mono text-[12px]" : ""}`}
        >
          {v ?? <span className="text-mist-600">—</span>}
        </span>
        {copy && v && <CopyButton value={v} />}
      </span>
    </div>
  );
}
