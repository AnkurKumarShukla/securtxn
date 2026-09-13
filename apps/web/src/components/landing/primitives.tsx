// Small shared pieces used across the landing sections.
//
// Kept in one file because each is a handful of lines and they only exist to
// stop the same markup being retyped six times with slightly different padding.

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The section label above every heading.
 *
 * A monospace, letterspaced marker. It does the work a paragraph of preamble
 * would otherwise do: it tells you where you are in one glance.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="h-px w-8 bg-signal-500/60" aria-hidden />
      <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-signal-300/80">
        {children}
      </span>
    </div>
  );
}

export function SectionHeading({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <h2
      className={`text-balance text-3xl font-semibold leading-[1.1] text-mist-50 sm:text-4xl lg:text-5xl ${className}`}
    >
      {children}
    </h2>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 max-w-xl text-pretty text-base leading-relaxed text-mist-400 sm:text-lg">
      {children}
    </p>
  );
}

/**
 * Shared button geometry.
 *
 * Fixed height rather than vertical padding, so the primary and the ghost line
 * up exactly whatever is inside them. A pair of pills that differ by a pixel is
 * the sort of thing nobody consciously notices and everybody registers.
 */
const BUTTON_BASE =
  "group relative inline-flex h-12 items-center justify-center gap-2 overflow-hidden rounded-full px-7 text-sm font-semibold tracking-[-0.006em] " +
  "transition-[transform,box-shadow,background-color,border-color,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] " +
  "active:translate-y-0 active:scale-[0.985] motion-reduce:transform-none";

/**
 * The primary action.
 *
 * One filled button per screen. If two things look equally important, the
 * viewer picks neither.
 *
 * WHAT MAKES IT READ AS EXPENSIVE, and none of it is the colour:
 *
 *   A flat fill looks printed on. This has a top-to-bottom gradient, so the
 *   surface has a direction, plus a bright inset line along its top edge — the
 *   same trick as the glass nav, and the reason both look like objects rather
 *   than rectangles.
 *
 *   The shadow is tinted with the accent rather than black. An accent-coloured
 *   glow under a coloured button reads as the button lighting the surface it
 *   sits on; a grey drop shadow reads as a sticker.
 *
 *   It lifts one pixel on hover and settles back on press. One pixel is enough
 *   to feel; more looks like it is bouncing.
 */
export function PrimaryButton({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Link
      href={href}
      className={`${BUTTON_BASE} bg-linear-to-b from-signal-400 to-signal-600 text-ink-950 shadow-[0_1px_0_0_rgba(255,255,255,0.45)_inset,0_10px_28px_-10px_rgba(91,140,255,0.85),0_2px_6px_-2px_rgba(0,0,0,0.5)] hover:-translate-y-px hover:brightness-[1.06] hover:shadow-[0_1px_0_0_rgba(255,255,255,0.55)_inset,0_16px_38px_-12px_rgba(91,140,255,1),0_3px_8px_-2px_rgba(0,0,0,0.55)] ${className}`}
    >
      {/* A hairline ring inside the edge. Without it the gradient meets the
          background with nothing to define the boundary and the pill looks soft. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-white/25"
      />
      {/* The sheen sweeps once on hover. Any longer and it reads as a loading
          state on a button that is not loading. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-white/40 to-transparent transition-transform duration-[900ms] ease-out group-hover:translate-x-full motion-reduce:hidden"
      />
      <span className="relative">{children}</span>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="relative h-3.5 w-3.5 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1 motion-reduce:transform-none"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    </Link>
  );
}

/**
 * The secondary action, built as the same smoked glass as the nav.
 *
 * A plain outlined pill next to a lit one looks unfinished rather than
 * secondary. Giving it the page's own glass material makes it read as
 * deliberately quieter, and ties the two buttons to the nav above them.
 */
export function GhostButton({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Link
      href={href}
      className={`${BUTTON_BASE} border border-white/12 bg-white/[0.045] bg-linear-to-b from-white/[0.07] to-transparent text-mist-200 backdrop-blur-md shadow-[0_1px_0_0_rgba(255,255,255,0.14)_inset,0_8px_24px_-12px_rgba(0,0,0,0.8)] hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.07] hover:text-mist-50 ${className}`}
    >
      <span className="relative">{children}</span>
    </Link>
  );
}

/** A hairline divider that fades at both ends rather than stopping abruptly. */
export function FadedRule({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`h-px w-full bg-gradient-to-r from-transparent via-mist-400/18 to-transparent ${className}`}
    />
  );
}

export function Section({
  id,
  children,
  className = "",
}: {
  id: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section id={id} className={`relative px-6 py-24 sm:py-32 lg:px-8 ${className}`}>
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}
