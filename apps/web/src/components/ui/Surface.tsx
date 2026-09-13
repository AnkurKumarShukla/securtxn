"use client";

// The two elevations, and the section header that sits on them.
//
// Three depths exist in the app: the page ground, a panel on it, and a well
// recessed into a panel. They are `@utility` classes in globals.css so that a
// panel cannot drift to a slightly different grey in one file — which is
// exactly what happened when both app pages carried their own `S.card`.

import type { ReactNode } from "react";
import SpotlightCard from "../reactbits/SpotlightCard";

export function Panel({
  children,
  className = "",
  /** Pointer-tracking sheen. Worth it on cards a person hunts through; noise on a static sidebar. */
  spotlight = false,
}: {
  children: ReactNode;
  className?: string | undefined;
  spotlight?: boolean | undefined;
}) {
  if (spotlight) {
    return (
      <SpotlightCard
        className={`panel ${className}`}
        spotlightColor="rgba(91, 140, 255, 0.10)"
      >
        {children}
      </SpotlightCard>
    );
  }
  return <div className={`panel ${className}`}>{children}</div>;
}

export function Well({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`well ${className}`}>{children}</div>;
}

/**
 * The small capitalised marker above a group.
 *
 * Same job as the landing page's `Eyebrow`: it replaces a sentence of preamble
 * with something the eye resolves in one glance.
 */
export function GroupLabel({
  children,
  right,
  className = "",
}: {
  children: ReactNode;
  right?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={`mb-3 flex items-center justify-between gap-3 ${className}`}>
      <span className="font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
        {children}
      </span>
      {right}
    </div>
  );
}
