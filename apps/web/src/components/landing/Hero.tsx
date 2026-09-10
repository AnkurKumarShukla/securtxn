"use client";

import Prism from "../reactbits/Prism";
import { SiteNav } from "./SiteNav";
import { GhostButton, PrimaryButton } from "./primitives";

/**
 * The hero.
 *
 * One line and one claim. Everything that would have gone here — the stats, the
 * proof points, the security model — has a section of its own further down, and
 * repeating it above the fold only makes the fold longer.
 *
 * The prism runs at its own defaults so the colour reads at full strength, and
 * the scrims are kept deliberately light: they exist to hold the type legible,
 * not to mute the artwork. `suspendWhenOffscreen` still stops the render loop
 * on scroll, because it is a hundred-step raymarch every frame.
 */
export function Hero() {
  return (
    <section className="relative isolate flex min-h-[100svh] items-center justify-center overflow-hidden px-6 lg:px-8">
      <SiteNav />

      <div className="absolute inset-0 -z-10">
        <Prism
          animationType="rotate"
          timeScale={0.5}
          height={3.5}
          baseWidth={5.5}
          scale={3.6}
          hueShift={0}
          colorFrequency={1}
          noise={0}
          glow={1}
          suspendWhenOffscreen
        />
      </div>

      {/* A soft accent bloom behind the nav.
          The prism's own light sits low in the frame, which left the top strip
          near-black — and frosted glass over black is just a dark bar. This
          gives the bar something to refract without lighting the whole hero. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-72 w-208 -translate-x-1/2 -translate-y-1/3 rounded-full bg-signal-500/25 blur-[90px]"
      />

      {/* One pass behind the copy, so white type has something to hold onto
          without flattening the prism around it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_45%_at_50%_52%,rgba(5,6,9,0.72)_0%,rgba(5,6,9,0.35)_45%,transparent_75%)]"
      />
      {/* A short fade into the next section so the canvas does not end on a line. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-32 bg-linear-to-t from-ink-950 to-transparent"
      />

      <div className="relative mx-auto w-full max-w-3xl text-center">
        <h1 className="text-balance text-[2.6rem] font-semibold leading-[1.05] text-white sm:text-6xl lg:text-7xl">
          Never pay the wrong wallet.
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-mist-200 sm:text-lg">
          SecurTxn is the control layer that verifies identity before the money moves without storing your sensitive data
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PrimaryButton href="/payments">Launch App</PrimaryButton>
          <GhostButton href="#how">See how it works</GhostButton>
        </div>
      </div>

      <a
        href="#problem"
        aria-label="Scroll to the problem"
        className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 text-white/40 transition-colors hover:text-white/70 lg:block"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5 animate-bounce"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 5v14M6 13l6 6 6-6" />
        </svg>
      </a>
    </section>
  );
}
