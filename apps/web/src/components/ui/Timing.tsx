"use client";

// Durations.
//
// Two shapes: the settled `{n}ms` badge a finished step keeps, and a counter
// that ticks while one is running. The live one matters for the DigiLocker
// steps, where the honest answer to "is this stuck?" is a five-minute budget
// and no feedback at all today.

import { useEffect, useState } from "react";
import { duration, millis } from "../../lib/format";

export function Timing({ ms, className = "" }: { ms: number; className?: string }) {
  return (
    <span className={`font-mono text-[10.5px] tabular-nums text-mist-600 ${className}`}>
      {millis(ms)}
    </span>
  );
}

/**
 * Counts up from a start instant.
 *
 * One second is plenty of resolution — a step row that reflows ten times a
 * second is a distraction, and nobody is timing this to the millisecond.
 */
export function Elapsed({ since, className = "" }: { since: number; className?: string }) {
  const [now, setNow] = useState(since);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);

  return (
    <span className={`font-mono text-[10.5px] tabular-nums text-mist-500 ${className}`}>
      {duration(Math.max(0, now - since))}
    </span>
  );
}

/**
 * Counts DOWN against a deadline.
 *
 * Used for the DigiLocker five-minute consent budget and the escrow timelock.
 * Both are currently invisible: the first shows a spinner that could mean
 * anything, and the second an ISO string nobody can subtract in their head.
 */
export function Countdown({
  deadline,
  className = "",
  expired = "time is up",
}: {
  deadline: number;
  className?: string | undefined;
  expired?: string | undefined;
}) {
  const [now, setNow] = useState(deadline);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const left = deadline - now;
  // Under a minute the wait has become the story, so it stops being grey.
  const urgent = left > 0 && left < 60_000;

  return (
    <span
      className={`font-mono text-[10.5px] tabular-nums ${urgent ? "text-halt-400" : "text-pending-400"} ${className}`}
    >
      {left <= 0 ? expired : `${duration(left)} left`}
    </span>
  );
}
