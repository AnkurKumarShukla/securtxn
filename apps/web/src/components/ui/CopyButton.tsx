"use client";

// Copy, with an acknowledgement.
//
// The old affordance was a bare `⧉` glyph that did nothing visible on click, so
// the only way to know whether a 42-character address had been copied was to
// paste it somewhere and look. This swaps to a tick for a moment instead.

import { useCallback, useEffect, useRef, useState } from "react";

export function CopyButton({
  value,
  label = "copy",
  className = "",
}: {
  value: string;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters here: these live inside rows that a 5-second
  // poll can replace, and a timer firing into a gone component is a warning in
  // the console for something nobody can see.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    // `navigator.clipboard` is undefined on a non-secure, non-localhost origin,
    // and this console is routinely served through an ngrok tunnel so a
    // counterparty can open it from another machine. Calling it there throws
    // and the button silently does nothing — on values (addresses, vendor ids)
    // whose entire purpose is to be handed to the other party.
    //
    // The fallback is the old execCommand path: deprecated, but it is the only
    // thing that works on http and it costs eight lines.
    void (async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const scratch = document.createElement("textarea");
          scratch.value = value;
          scratch.setAttribute("readonly", "");
          scratch.style.position = "fixed";
          scratch.style.opacity = "0";
          document.body.appendChild(scratch);
          scratch.select();
          document.execCommand("copy");
          document.body.removeChild(scratch);
        }
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1200);
      } catch {
        // Nothing useful to say — the value is still on screen to select.
      }
    })();
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      title={done ? "copied" : label}
      aria-label={done ? "copied" : label}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors duration-[--dur-fast] ${
        done ? "text-verified-400" : "text-mist-600 hover:text-mist-200"
      } ${className}`}
    >
      {done ? (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3.5 8.5 6.5 11.5 12.5 5" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" />
        </svg>
      )}
    </button>
  );
}
