"use client";

// "Nothing here yet."
//
// The payee page has three of these, and in every case the empty state is
// genuinely informative rather than a placeholder — "nothing yet, and here is
// what has to happen first" is the answer to the question the person is
// actually asking. So the body text is kept verbatim from the original copy.
//
// A RECESS, NOT A DASHED BOX. The dashed border is the web's convention for
// "something is missing here", and it survives because on a flat surface there
// is no other way to say it. This material has one: the absence sinks into the
// panel instead of being outlined on it. Dashed edges have no light source and
// read as a wireframe left in by accident.

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
      className={`well flex flex-col items-center px-6 py-8 text-center ${className}`}
    >
      {icon && <div className="mb-3 text-mist-600">{icon}</div>}
      <p className="text-[13px] font-medium text-mist-300">{title}</p>
      {children && (
        <p className="mt-1.5 max-w-sm text-[12px] leading-relaxed text-mist-500">{children}</p>
      )}
    </div>
  );
}
