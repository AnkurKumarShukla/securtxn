// The status vocabulary, in one place.
//
// WHY THIS FILE EXISTS. Before it, `console/page.tsx` carried its own
// `STATE_COLOUR` map of raw hex — a green, an amber and a red that belonged to
// no palette and meant nothing beyond that one file. The design system already
// reserves `verified-400` and `halt-400` for exactly "passed" and "refused",
// and says in a comment that colour which is decorative stops meaning anything.
//
// So: every status colour in the app is chosen here and nowhere else.

import type { StepState } from "../../lib/flow";

/**
 * The rendered states.
 *
 * `waiting` is PRESENTATIONAL ONLY and is never stored. The runner's
 * `StepState` has no such member and must not gain one — a step blocked on a
 * human is still `running` as far as the state machine is concerned. See
 * `toneOf()` for how it is derived.
 */
export type Tone = StepState | "waiting";

export type ToneStyle = {
  /** Text colour class. */
  fg: string;
  /** A faint fill, for pills and row washes. */
  bg: string;
  /** Border / left-rule colour class. */
  edge: string;
  /** Solid fill, for progress segments and filled badges. */
  solid: string;
  /** What the badge says. */
  label: string;
};

export const TONE: Record<Tone, ToneStyle> = {
  idle: {
    fg: "text-mist-600",
    bg: "bg-mist-600/8",
    edge: "border-mist-600/40",
    solid: "bg-mist-600/50",
    label: "idle",
  },
  running: {
    fg: "text-signal-400",
    bg: "bg-signal-500/10",
    edge: "border-signal-500/50",
    solid: "bg-signal-500",
    label: "running",
  },
  // The system is idle and a PERSON is the blocker. The only state on the page
  // an operator can act on, which is why it is the only one that is amber.
  waiting: {
    fg: "text-pending-400",
    bg: "bg-pending-400/10",
    edge: "border-pending-400/50",
    solid: "bg-pending-400",
    label: "needs you",
  },
  ok: {
    fg: "text-verified-400",
    bg: "bg-verified-400/10",
    edge: "border-verified-400/45",
    solid: "bg-verified-400",
    label: "ok",
  },
  failed: {
    fg: "text-halt-400",
    bg: "bg-halt-400/10",
    edge: "border-halt-400/50",
    solid: "bg-halt-400",
    label: "failed",
  },
  // Declared by the runner's type but never produced by any code path today.
  // Rendered anyway so that if one ever is, it does not fall through to idle
  // and read as "not started yet".
  skipped: {
    fg: "text-mist-600",
    bg: "bg-mist-600/8",
    edge: "border-mist-600/30",
    solid: "bg-mist-600/30",
    label: "skipped",
  },
};

/**
 * Derives the rendered tone from a step's record.
 *
 * A step is "waiting" when it is running AND either it carries a prompt the
 * operator has to act on (the DigiLocker consent URL, pushed mid-flight by the
 * runner's `report()`) or it is one of the `manual` steps that cannot finish
 * without a human. Everything else renders as whatever the runner stored.
 */
export function toneOf(
  state: StepState,
  opts: { prompt?: unknown; manual?: boolean | undefined },
): Tone {
  if (state === "running" && (opts.prompt !== undefined || opts.manual)) return "waiting";
  return state;
}
