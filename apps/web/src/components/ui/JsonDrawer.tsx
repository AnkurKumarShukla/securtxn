"use client";

// The raw request and response, one click away.
//
// NOTHING IS REMOVED BY THE REDESIGN. The summary rows promote a handful of
// fields per step because those are the ones a human acts on, but the complete
// payload stays exactly as it was — same "signed / sent" and "response"
// labels, same `JSON.stringify(value, null, 2)`. Collapsing it is the only
// change: sixteen expanded payloads made the page a debug log rather than a
// console, and the interesting one was never on screen.

import { useState } from "react";
import { CopyButton } from "./CopyButton";

export function JsonDrawer({
  request,
  response,
  className = "",
}: {
  request?: unknown | undefined;
  response?: unknown | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);

  const hasRequest = request !== undefined;
  const hasResponse = response !== undefined;
  if (!hasRequest && !hasResponse) return null;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.1em] text-mist-500 uppercase transition-colors duration-[--dur-fast] hover:text-mist-200"
      >
        <svg
          viewBox="0 0 16 16"
          className={`h-3 w-3 transition-transform duration-[--dur-fast] ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
        {open ? "hide" : "raw"} {hasRequest ? "request / response" : "response"}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {hasRequest && <Block label="signed / sent" value={request} />}
          {hasResponse && <Block label="response" value={response} />}
        </div>
      )}
    </div>
  );
}

function Block({ label, value }: { label: string; value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="well overflow-hidden">
      <div className="flex items-center justify-between gap-2 hairline-b px-2.5 py-1.5">
        <span className="font-mono text-[10px] tracking-[0.12em] text-mist-500 uppercase">
          {label}
        </span>
        <CopyButton value={text ?? "null"} label={`copy ${label}`} />
      </div>
      <pre className="max-h-72 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-mist-300">
        {text}
      </pre>
    </div>
  );
}
