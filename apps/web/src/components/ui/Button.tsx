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
  // Matched to PrimaryButton in the landing primitives: top-to-bottom gradient
  // so the surface has a direction, a bright inset line along the top edge, and
  // a shadow tinted with the accent rather than black — an accent glow reads as
  // the button lighting the surface, a grey one reads as a sticker.
  primary:
    "bg-linear-to-b from-signal-400 to-signal-600 text-ink-950 " +
    "shadow-[0_1px_0_0_rgba(255,255,255,0.40)_inset,0_8px_20px_-10px_rgba(91,140,255,0.8)] " +
    "hover:not-disabled:-translate-y-px hover:not-disabled:brightness-[1.06]",
  // The landing page's secondary is the same smoked glass as the nav; a plain
  // outline next to a lit pill looks unfinished rather than deliberately quiet.
  ghost:
    "hairline-strong bg-white/[0.045] bg-linear-to-b from-white/[0.06] to-transparent text-mist-200 " +
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
