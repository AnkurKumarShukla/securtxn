"use client";

// The state of a step, as a shape.
//
// Colour alone is not enough: roughly one in twelve men cannot separate the
// green from the red reliably, and this is a screen where "passed" and
// "refused" must never be confused. So each state gets a distinct SILHOUETTE —
// ring, spinner, dot, tick, cross — and the colour reinforces it rather than
// carrying it alone.

import { TONE, type Tone } from "./status";

export function StepGlyph({ tone, size = 18 }: { tone: Tone; size?: number }) {
  const s = TONE[tone];
  const box = { width: size, height: size };

  if (tone === "ok") {
    return (
      <span
        style={box}
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${s.bg} ${s.fg}`}
      >
        <svg viewBox="0 0 16 16" className="h-[62%] w-[62%]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3.5 8.5 6.5 11.5 12.5 5" />
        </svg>
      </span>
    );
  }

  if (tone === "failed") {
    return (
      <span
        style={box}
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${s.bg} ${s.fg}`}
      >
        <svg viewBox="0 0 16 16" className="h-[58%] w-[58%]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
        </svg>
      </span>
    );
  }

  if (tone === "running") {
    return (
      <span style={box} className={`inline-flex shrink-0 items-center justify-center ${s.fg}`}>
        <svg viewBox="0 0 16 16" className="h-full w-full motion-safe:animate-spin" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  if (tone === "waiting") {
    // Breathing, not spinning. A spinner says "the machine is busy"; this state
    // means the opposite — nothing is happening until a person acts.
    return (
      <span style={box} className="inline-flex shrink-0 items-center justify-center">
        <span className={`h-[52%] w-[52%] rounded-full ${s.solid} motion-safe:animate-[breathe_1.8s_ease-in-out_infinite]`} />
      </span>
    );
  }

  if (tone === "skipped") {
    return (
      <span style={box} className={`inline-flex shrink-0 items-center justify-center ${s.fg}`}>
        <svg viewBox="0 0 16 16" className="h-full w-full" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <circle cx="8" cy="8" r="6" strokeOpacity="0.4" />
          <path d="M5.5 8h5" />
        </svg>
      </span>
    );
  }

  // idle — a hollow ring. Deliberately the quietest thing in the column.
  return (
    <span style={box} className={`inline-flex shrink-0 items-center justify-center ${s.fg}`}>
      <svg viewBox="0 0 16 16" className="h-full w-full" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
      </svg>
    </span>
  );
}
