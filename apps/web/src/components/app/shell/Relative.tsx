"use client";

// A timestamp, as a person reads it.
//
// MOUNT-GATED, AND THAT IS THE WHOLE POINT. "3 minutes ago" computed on the
// server and again on the client produces two different strings, and React
// discards the tree on that mismatch. So this renders a stable absolute date
// first and swaps to the relative form once mounted.

import { useEffect, useState } from "react";
import { duration } from "../../../lib/format";

export function Relative({ iso, className = "" }: { iso: string; className?: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    // A minute is enough resolution for a list. Anything faster is a row that
    // reflows while someone is trying to read it.
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return <span className={className}>—</span>;

  if (now === null) {
    // Server and first client pass agree on this, because it derives only from
    // the prop.
    return (
      <time dateTime={iso} className={className}>
        {iso.slice(0, 10)}
      </time>
    );
  }

  const delta = now - at;
  const text =
    delta < 45_000
      ? "just now"
      : delta < 0
        ? `in ${duration(-delta)}`
        : `${duration(delta)} ago`;

  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className}>
      {text}
    </time>
  );
}
