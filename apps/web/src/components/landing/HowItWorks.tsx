"use client";

import { PipelineCamera } from "./PipelineCamera";
import { Reveal } from "./Reveal";
import { Eyebrow, Lede, Section, SectionHeading } from "./primitives";

/**
 * How it works.
 *
 * This used to be four stacked cards and a sticky rail — the same four facts
 * read four times, once per card. The pipeline is one object, so it is drawn as
 * one object now, and the per-stage detail lives inside it rather than beside
 * it.
 */
export function HowItWorks() {
  return (
    <Section id="how" className="border-t border-white/[0.05] bg-ink-900">
      <div className="pointer-events-none absolute inset-0 grid-veil opacity-40" aria-hidden />

      <Reveal>
        <div className="relative max-w-2xl">
          <Eyebrow>How it works</Eyebrow>
          <SectionHeading>One payment, from invoice to receipt.</SectionHeading>
          <Lede>
            Four stages, each refusing something the next one would otherwise
            have to trust. What travels between them is written on the line.
          </Lede>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="relative mt-14">
          <PipelineCamera />
        </div>
      </Reveal>
    </Section>
  );
}
