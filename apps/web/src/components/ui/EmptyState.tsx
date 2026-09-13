"use client";

// "Nothing here yet."
//
// The payee page has three of these, and in every case the empty state is
// genuinely informative rather than a placeholder — "nothing yet, and here is
// what has to happen first" is the answer to the question the person is
// actually asking. So the body text is kept verbatim from the original copy.
//
// NO BOX AT ALL. This went from a dashed outline to a recessed well, and the
// well was still one shape too many: an empty state already sits inside a
// panel, so drawing a second surface inside the first puts a hole in a card to
// say there is nothing in the card. Two nested boxes is not more emphasis, it
// is more furniture. The words are the content; the panel is the container.

import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  children,
  className = "",
}: {
  icon?: ReactNode | undefined;
  title: string;
  children?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={`flex flex-col items-center px-6 py-10 text-center ${className}`}
    >
      {icon && <div className="mb-3 text-mist-600">{icon}</div>}
      <p className="text-[13px] font-medium text-mist-300">{title}</p>
      {children && (
        <p className="mt-1.5 max-w-sm text-[12px] leading-relaxed text-mist-500">{children}</p>
      )}
    </div>
  );
}
