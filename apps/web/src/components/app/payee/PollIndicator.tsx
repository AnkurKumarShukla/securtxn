"use client";

// Proof the inbox is actually being checked.
//
// The poll swallows every failure — deliberately, because a banner appearing
// every five seconds would be worse than useless. But the cost was that a dead
// API and an empty inbox looked identical, and "nothing has arrived" is exactly
// the wrong conclusion to draw from a broken connection.
//
// This changes no request. It only says whether the last one worked.

import { useEffect, useState } from "react";
import { IconButton, RefreshIcon } from "../../ui/Button";

export function PollIndicator({
  at,
  failed,
  onCheck,
}: {
  at: number | null;
  failed: boolean;
  onCheck: () => void;
}) {
  const [now, setNow] = useState<number | null>(null);

  // Mount-gated: a relative time rendered on the server and again on the client
  // is a hydration mismatch waiting to happen.
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const ago = at !== null && now !== null ? Math.max(0, Math.round((now - at) / 1000)) : null;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          failed ? "bg-pending-400" : "bg-verified-400 motion-safe:animate-[breathe_2.4s_ease-in-out_infinite]"
        }`}
        aria-hidden
      />
      <span className={`text-[11.5px] ${failed ? "text-pending-400" : "text-mist-500"}`}>
        {failed
          ? "last check failed"
          : ago === null
            ? "checking…"
            : `checked ${ago}s ago`}
      </span>
      <IconButton icon={<RefreshIcon />} label="Check now" onClick={onCheck} />
    </div>
  );
}
