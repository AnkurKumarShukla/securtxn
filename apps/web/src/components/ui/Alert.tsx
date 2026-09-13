"use client";

// Inline messages, in three severities.
//
// The distinction matters more here than in most apps, because this flow
// produces a lot of things that LOOK like failures and are not:
//
//   • `awaitConsent` reporting "still 'DRAFT'" means the payee has not acted
//     yet. That is the flow working, not breaking.
//   • `consentPrompt` returning 409 means the payee already answered.
//   • `escrow` returning 404 means the payment settled DIRECT, as chosen at P1.
//
// Painting those red trains an operator to ignore red. So: `error` is reserved
// for something that actually went wrong, `warn` for something waiting on a
// person, and `info` for an explanation.

import type { ReactNode } from "react";

type Tone = "error" | "warn" | "info";

const TONES: Record<Tone, { box: string; icon: string; mark: ReactNode }> = {
  error: {
    box: "border-halt-400/30 bg-halt-400/[0.07]",
    icon: "text-halt-400",
    mark: <path d="M8 4.5v4.5M8 11.2v.3" />,
  },
  warn: {
    box: "border-pending-400/30 bg-pending-400/[0.07]",
    icon: "text-pending-400",
    mark: <path d="M8 4.5v4.5M8 11.2v.3" />,
  },
  info: {
    box: "border-signal-500/25 bg-signal-500/[0.07]",
    icon: "text-signal-400",
    mark: <path d="M8 7.5v4M8 4.8v.3" />,
  },
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: Tone | undefined;
  title?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** A button or link pulled to the right — "Open DigiLocker", "Go to /payee". */
  action?: ReactNode | undefined;
  className?: string | undefined;
}) {
  const t = TONES[tone];

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 ${t.box} ${className}`}
    >
      <svg
        viewBox="0 0 16 16"
        className={`mt-px h-4 w-4 shrink-0 ${t.icon}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="8" cy="8" r="6.25" strokeOpacity="0.5" />
        {t.mark}
      </svg>

      <div className="min-w-0 flex-1">
        {title && <div className="text-[12.5px] font-medium text-mist-50">{title}</div>}
        {children && (
          <div
            className={`text-[12px] leading-relaxed break-words text-mist-300 ${title ? "mt-1" : ""}`}
          >
            {children}
          </div>
        )}
      </div>

      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
