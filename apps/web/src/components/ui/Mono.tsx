"use client";

// Addresses and hashes.
//
// These are the values the whole product is about — a payment goes wrong
// precisely when someone reads one of them carelessly. So: monospace, both ends
// preserved by the truncation, the full string in a tooltip, and copy always
// one click away rather than a text selection across an ellipsis.

import { truncate } from "../../lib/format";
import { CopyButton } from "./CopyButton";
import { Tooltip } from "./Tooltip";

export function Hash({
  value,
  chars = 6,
  copy = true,
  className = "",
}: {
  value: string | null | undefined;
  chars?: number | undefined;
  copy?: boolean | undefined;
  className?: string | undefined;
}) {
  if (!value) return <span className="text-mist-600">—</span>;

  const short = truncate(value, chars);
  const truncated = short !== value;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {truncated ? (
        <Tooltip content={<span className="font-mono break-all">{value}</span>}>
          <span className="font-mono text-[12.5px] text-mist-200 underline decoration-dotted decoration-mist-600 underline-offset-4">
            {short}
          </span>
        </Tooltip>
      ) : (
        <span className="font-mono text-[12.5px] break-all text-mist-200">{value}</span>
      )}
      {copy && <CopyButton value={value} label="copy full value" />}
    </span>
  );
}

/** An inline code span, for signals, reason codes and enum values. */
export function Code({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={`rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] break-all text-signal-300 ${className}`}
    >
      {children}
    </code>
  );
}
