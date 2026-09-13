"use client";

// A tooltip, in CSS.
//
// No dependency and no portal: these are short strings attached to values in a
// scrolling column, and a positioning library for that is a lot of bundle for a
// `group-hover`. The trade-off is that it cannot escape an `overflow: hidden`
// ancestor — so panels that host one must not clip, and the JSON drawer (which
// must clip) uses plain `title` instead.

import type { ReactNode } from "react";

export function Tooltip({
  content,
  children,
  side = "top",
  className = "",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={`group/tip relative inline-flex items-center ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-50 w-max max-w-xs -translate-x-1/2 rounded-xs hairline-strong bg-ink-800 px-2.5 py-1.5 text-left text-[11px] leading-snug text-mist-200 opacity-0 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.9)] transition-opacity duration-[--dur-fast] group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 ${
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}
      >
        {content}
      </span>
    </span>
  );
}
