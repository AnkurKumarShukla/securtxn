"use client";

// The activity log.
//
// The same array of lines the page always kept — newest first, capped at
// sixty, each prefixed with a local time. It was rendered as one `<pre>` of
// joined text, which meant a success and a failure looked identical until you
// read the glyph.
//
// The lines are NOT reformatted. `act()` already writes `✓ label` and
// `✗ label — message`, and changing that would change what "Copy log" produces
// and what anyone pastes into a bug report. This only parses the prefix that is
// already there.

import { Button } from "../../ui/Button";

type Entry = { time: string; tone: "ok" | "failed" | "plain"; text: string };

function parse(line: string): Entry {
  // `${time}  ${body}` — two spaces, written by the `say()` helper.
  const split = line.indexOf("  ");
  const time = split === -1 ? "" : line.slice(0, split);
  const body = split === -1 ? line : line.slice(split + 2);

  if (body.startsWith("✓ ")) return { time, tone: "ok", text: body.slice(2) };
  if (body.startsWith("✗ ")) return { time, tone: "failed", text: body.slice(2) };
  return { time, tone: "plain", text: body };
}

export function ActivityLog({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) {
    return <p className="text-[11.5px] text-mist-600">Nothing yet.</p>;
  }

  return (
    <div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
        {lines.map((line, i) => {
          const entry = parse(line);
          return (
            <div key={`${i}-${line.slice(0, 24)}`} className="flex gap-2 text-[11.5px] leading-snug">
              <span className="shrink-0 font-mono text-mist-600 tabular-nums">{entry.time}</span>
              <span
                className={`min-w-0 break-words ${
                  entry.tone === "ok"
                    ? "text-verified-400"
                    : entry.tone === "failed"
                      ? "text-halt-400"
                      : "text-mist-400"
                }`}
              >
                {entry.text}
              </span>
            </div>
          );
        })}
      </div>

      <Button
        variant="quiet"
        size="sm"
        className="mt-2.5 w-full"
        // Emits exactly what the old <pre> displayed, so anything already
        // pasted into a ticket still matches.
        onClick={() => void navigator.clipboard?.writeText(lines.join("\n"))}
      >
        copy log
      </Button>
    </div>
  );
}
