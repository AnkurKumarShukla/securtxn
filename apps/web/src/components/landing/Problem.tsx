"use client";

import CountUp from "../reactbits/CountUp";
import { Reveal } from "./Reveal";
import { Eyebrow, Lede, Section, SectionHeading } from "./primitives";

/**
 * The problem, told as a sequence rather than a paragraph.
 *
 * Four steps, each one an ordinary thing that happens, ending somewhere with no
 * way back. Reading it top to bottom is the argument; nothing here needs a
 * sentence explaining why it matters.
 */
const CHAIN = [
  {
    step: "01",
    title: "A vendor emails new bank details",
    note: "Or someone with access to their mailbox does.",
  },
  {
    step: "02",
    title: "An address is pasted into a payout",
    note: "Forty-two characters. Nobody reads the middle.",
  },
  {
    step: "03",
    title: "The transfer confirms in seconds",
    note: "Exactly as designed. That is the feature.",
  },
  {
    step: "04",
    title: "There is nobody to call",
    tone: "halt" as const,
    note: "No chargeback. No recall. No counterparty.",
  },
];

export function Problem() {
  return (
    <Section id="problem" className="border-t border-white/[0.05] bg-ink-900">
      <div className="pointer-events-none absolute inset-0 grid-veil opacity-[0.55]" aria-hidden />

      <div className="relative grid gap-16 lg:grid-cols-[0.95fr_1.05fr] lg:gap-20">
        <div>
          <Reveal>
            <Eyebrow>The problem</Eyebrow>
            <SectionHeading>
              Every safeguard in payments
              <br className="hidden sm:block" /> assumes someone can{" "}
              <span className="text-halt-400">undo it</span>.
            </SectionHeading>
            <Lede>
              On-chain, nothing can. The address is the account, the transfer is
              final, and a payment sent to the wrong wallet is not a dispute.
              It is a loss.
            </Lede>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.05]">
              <Stat
                value={<CountUp to={100} duration={1.6} className="tabular-nums" />}
                suffix="%"
                label="of misdirected sends are final"
              />
              <Stat
                value={<CountUp to={0} duration={1} className="tabular-nums" />}
                label="ways to reverse one afterwards"
              />
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.15}>
          <ol className="relative space-y-1">
            {/* The spine. It stops before the last marker so the sequence reads
                as ending, not continuing. */}
            <span
              aria-hidden
              className="absolute left-[27px] top-8 bottom-20 w-px bg-gradient-to-b from-white/12 via-white/12 to-halt-400/40"
            />
            {CHAIN.map((item) => (
              <li key={item.step} className="relative flex gap-5 py-4">
                <span
                  className={`relative z-10 flex h-14 w-14 shrink-0 items-center justify-center rounded-full border font-mono text-xs ${
                    item.tone === "halt"
                      ? "border-halt-400/35 bg-halt-400/[0.07] text-halt-400"
                      : "border-white/10 bg-ink-850 text-mist-500"
                  }`}
                >
                  {item.step}
                </span>
                <div className="pt-2.5">
                  <p
                    className={`text-[15px] font-medium sm:text-base ${
                      item.tone === "halt" ? "text-halt-400" : "text-mist-50"
                    }`}
                  >
                    {item.title}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-mist-500">{item.note}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </Section>
  );
}

function Stat({
  value,
  suffix,
  label,
}: {
  value: React.ReactNode;
  suffix?: string;
  label: string;
}) {
  return (
    <div className="bg-ink-900 px-6 py-7">
      <div className="flex items-baseline gap-0.5 font-mono text-4xl font-medium text-mist-50 sm:text-5xl">
        {value}
        {suffix && <span className="text-signal-400">{suffix}</span>}
      </div>
      <p className="mt-2 text-sm leading-snug text-mist-500">{label}</p>
    </div>
  );
}
