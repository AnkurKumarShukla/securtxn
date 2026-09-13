"use client";

// Page chrome.
//
// Every screen in the product has the same anatomy: a title, an optional line
// saying what the screen is for, actions on the right, and the content. Putting
// it in one place is what stops six screens each inventing their own heading
// size and gutter.

import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  lead,
  actions,
  back,
}: {
  title: ReactNode;
  lead?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  /** A parent screen to return to, e.g. from a payment detail. */
  back?: { href: string; label: string } | undefined;
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link
          href={back.href}
          className="mb-2.5 inline-flex items-center gap-1.5 text-[12px] text-mist-500 transition-colors hover:text-mist-200"
        >
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          {back.label}
        </Link>
      )}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-mist-50 sm:text-[26px]">
            {title}
          </h1>
          {lead && (
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-mist-500">{lead}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A number that matters, at the top of a screen.
 *
 * Deliberately not animated. A count-up on a payment total shows a value that
 * is briefly WRONG, and these are read once and acted on.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "default",
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode | undefined;
  tone?: "default" | "ok" | "warn" | "halt" | undefined;
  /** Makes the whole tile a link, for "3 awaiting approval". */
  href?: string | undefined;
}) {
  const colour =
    tone === "ok"
      ? "text-verified-400"
      : tone === "warn"
        ? "text-pending-400"
        : tone === "halt"
          ? "text-halt-400"
          : "text-mist-50";

  const body = (
    <>
      <span className="font-mono text-[10.5px] tracking-[0.14em] text-mist-500 uppercase">
        {label}
      </span>
      <span className={`mt-2 block text-[26px] leading-none font-semibold tabular-nums ${colour}`}>
        {value}
      </span>
      {sub && <span className="mt-1.5 block text-[11.5px] text-mist-500">{sub}</span>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        // A raised card that is also a link catches more light on hover rather
        // than gaining an outline. The panel has no border to brighten now, and
        // adding one back on hover would make the edge appear and disappear.
        className="panel block p-4 transition-colors duration-[--dur-press] hover:bg-ink-700"
      >
        {body}
      </Link>
    );
  }
  return <div className="panel p-4">{body}</div>;
}
