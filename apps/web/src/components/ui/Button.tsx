"use client";

// Buttons.
//
// `components/landing/primitives.tsx` already defines this geometry, but every
// one of its exports is a `next/link` — they navigate, and the app's buttons
// run things. Rather than fork the look, the primary here reproduces the
// landing page's gradient, inset rim and accent-tinted shadow exactly, so the
// product and the marketing page read as one object.
//
// The sizes are smaller than the landing page's fixed 48px pill: that height is
// right for two calls to action on an empty hero and wrong for a control bar
// above sixteen rows.

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "quiet" | "halt";
type Size = "sm" | "md";

const BASE =
  "relative inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-[-0.005em] " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-[--dur-fast] " +
  "disabled:cursor-not-allowed disabled:opacity-45 " +
  "active:translate-y-0 motion-reduce:transform-none";

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-4 text-[13px]",
};

const VARIANTS: Record<Variant, string> = {
  // FLAT FILL, NOT A GRADIENT. The gradient came from the landing page, where a
  // lit pill on a WebGL backdrop is the point. Here it fights the material:
  // this surface is matte and lit from one fixed direction, and a fill with its
  // own internal light source is a second lamp in the room. The extrusion does
  // the shaping now — a rim along the top edge and a soft accent shadow under
  // it, both of which agree with the global light.
  primary:
    "bg-signal-400 text-ink-950 " +
    "shadow-[0_1px_0_0_rgba(255,255,255,0.28)_inset,var(--shadow-accent)] " +
    "hover:not-disabled:bg-signal-300",
  // Quiet but present. Also flat, for the same reason.
  ghost:
    "hairline-strong bg-white/[0.045] text-mist-200 " +
    "hover:not-disabled:border-hairline-active hover:not-disabled:bg-white/[0.07] hover:not-disabled:text-mist-50",
  quiet:
    "hairline text-mist-500 hover:not-disabled:border-hairline-active hover:not-disabled:text-mist-200",
  // Destructive or terminating. `Deny` stops a payment dead; it should not look
  // like the same weight of action as `Accept`.
  halt:
    "border border-halt-400/35 bg-halt-400/10 text-halt-400 " +
    "hover:not-disabled:border-halt-400/60 hover:not-disabled:bg-halt-400/15",
};

export function Button({
  variant = "ghost",
  size = "md",
  busy = false,
  className = "",
  children,
  ...rest
}: {
  variant?: Variant | undefined;
  size?: Size | undefined;
  /** Shows a spinner and disables. The caller still owns the disabled prop. */
  busy?: boolean | undefined;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {busy && (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 motion-safe:animate-spin" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {children}
    </button>
  );
}

/** The ▶ affordance on a step row. Square, quiet, and out of the way until hovered. */
export function RunButton({
  className = "",
  label = "run this step",
  ...rest
}: { label?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-xs hairline text-mist-500 transition-colors duration-[--dur-fast] hover:not-disabled:border-signal-500/40 hover:not-disabled:bg-signal-500/10 hover:not-disabled:text-signal-300 disabled:cursor-not-allowed disabled:opacity-35 ${className}`}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden>
        <path d="M5 3.5v9l7-4.5-7-4.5Z" />
      </svg>
    </button>
  );
}

/**
 * Refresh, as an icon.
 *
 * Every list on this product had a word-shaped "Refresh" sitting next to its
 * real action, and two buttons of equal weight is a way of saying they matter
 * equally. They do not: one raises a payment, the other re-reads a list that
 * already re-reads itself. Shrinking it to a glyph puts it back in proportion
 * without removing it.
 *
 * The label still exists for anyone who cannot see the glyph — it is the
 * accessible name AND the tooltip, so the affordance is not lost, only the
 * visual weight.
 */
export function IconButton({
  icon,
  label,
  busy = false,
  className = "",
  ...rest
}: {
  icon: ReactNode;
  label: string;
  busy?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      disabled={rest.disabled || busy}
      className={
        "neu-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-800 " +
        "text-mist-400 transition-[box-shadow,color] duration-[--dur-press] ease-[--ease-standard] " +
        "hover:not-disabled:text-mist-100 active:not-disabled:neu-in-1 " +
        "disabled:cursor-not-allowed disabled:opacity-45 " +
        className
      }
    >
      <span className={busy ? "motion-safe:animate-spin" : undefined}>{icon}</span>
    </button>
  );
}

/** The circular arrow every list uses. One definition, so they cannot drift. */
export function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.2V5h-2.8" />
    </svg>
  );
}
