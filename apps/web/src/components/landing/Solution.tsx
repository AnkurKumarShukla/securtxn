"use client";

import LetterGlitch from "../reactbits/LetterGlitch";
import SpotlightCard from "../reactbits/SpotlightCard";
import { Reveal } from "./Reveal";
import { Eyebrow, Lede, Section, SectionHeading } from "./primitives";

const FEATURES = [
  {
    title: "Government-signed identity",
    body: "Documents pulled straight from the issuing authority, with the signature checked. Not a photo of an ID.",
    icon: IdIcon,
  },
  {
    title: "Three gates per address",
    body: "Key control, identity binding, and a callback on a number the registry gave us. All three, or it is not payable.",
    icon: GateIcon,
  },
  {
    title: "An ordered decision engine",
    body: "Sanctions, duplicates, tier limits, name match. First failure wins, and the reason is recorded.",
    icon: FlowIcon,
  },
  {
    title: "Escrowed settlement",
    body: "The payee reveals a secret to collect. That reveal is a receipt they cannot take back.",
    icon: LockIcon,
  },
  {
    title: "Recovery by default",
    body: "Unclaimed funds return to the payer when the clock runs out. No counterparty needed.",
    icon: ReturnIcon,
  },
  {
    title: "Evidence anyone can check",
    body: "A hash chain, with its root published to a public consensus topic. Verify it without asking us.",
    icon: ProofIcon,
  },
];

export function Solution() {
  return (
    <Section id="solution" className="border-t border-white/[0.05]">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>The solution</Eyebrow>
          <SectionHeading>
            Verify the payee.
            <br className="hidden sm:block" /> Then make the payment{" "}
            <span className="text-verified-400">recoverable</span>.
          </SectionHeading>
          <Lede>
            Two ideas, applied in order. Nothing here asks the chain to change,
            and nothing depends on a counterparty being reachable afterwards.
          </Lede>
        </div>
      </Reveal>

      {/* The security panel. LetterGlitch is doing one job: making the claim
          feel like machinery rather than marketing. Which means it has to be
          visible — the first pass buried it under a 72% scrim plus the
          component's own centre vignette, and the effect had no chance. The
          scrim is now graded instead of flat: dense where the copy sits, thin
          where the spec list carries its own surfaces. */}
      <Reveal delay={0.1}>
        <div className="relative mt-16 overflow-hidden rounded-3xl border border-white/[0.08]">
          <div className="absolute inset-0" aria-hidden>
            <LetterGlitch
              glitchSpeed={62}
              smooth
              // Outer only. `centerVignette` paints an 80% black disc across the
              // middle, which is precisely where this panel's content sits — it
              // was hiding the effect it was supposed to frame.
              outerVignette
              backgroundColor="#050609"
              // Palette-locked to the one accent plus the verified green, so the
              // panel reads as this product and not as a generic terminal.
              // Lifted off near-black: at 0.28 luminance the darkest character
              // was invisible under any scrim at all.
              glitchColors={["#31477a", "#6e9bff", "#5bd6a0"]}
            />
          </div>
          {/* One knock-down, and no blur. Blurring the characters softened them
              into a smear, which cost more legibility than the scrim did. */}
          <div aria-hidden className="absolute inset-0 bg-ink-950/45" />
          {/* Denser behind the copy than behind the spec list, which carries its
              own surfaces. Vertical on small screens where the columns stack. */}
          <div
            aria-hidden
            className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,9,0.62)_0%,rgba(5,6,9,0.30)_100%)] lg:bg-[linear-gradient(100deg,rgba(5,6,9,0.72)_0%,rgba(5,6,9,0.45)_45%,transparent_82%)]"
          />

          <div className="relative grid gap-10 px-7 py-14 sm:px-12 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-16">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-verified-400/90">
                Security model
              </p>
              <h3 className="mt-5 text-balance text-2xl font-semibold leading-tight text-mist-50 sm:text-4xl">
                Nothing is trusted because it was typed in.
              </h3>
              <p className="mt-5 max-w-lg text-pretty text-sm leading-relaxed text-mist-200 sm:text-base">
                Every fact behind a payout is signed by someone with something to
                lose: the issuing authority, the wallet holder, the approver, or
                the network itself. Assertions are checked, never accepted.
              </p>
            </div>

            <ul className="space-y-px overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.05]">
              {[
                ["XMLDSig", "Issuer signature on every document"],
                ["EIP-712", "Wallet control and receipt, signed"],
                ["keccak256", "Hash-chained evidence, verified on read"],
                ["AES-256-GCM", "Personal data encrypted at rest"],
              ].map(([label, what]) => (
                <li
                  key={label}
                  className="flex items-center justify-between gap-4 bg-ink-950/80 px-5 py-3.5 backdrop-blur-sm"
                >
                  <span className="font-mono text-xs text-signal-300">{label}</span>
                  <span className="text-right text-xs leading-snug text-mist-400">
                    {what}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>

      {/* <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, i) => (
          <Reveal key={feature.title} delay={0.05 * (i % 3)}>
            <SpotlightCard
              className="group h-full rounded-2xl border border-white/[0.07] bg-ink-900 p-7 transition-colors duration-500 hover:border-white/[0.14]"
              spotlightColor="rgba(91, 140, 255, 0.12)"
            >
              <div className="relative">
                <div className="mb-5 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-signal-400 transition-colors duration-500 group-hover:border-signal-500/30 group-hover:text-signal-300">
                  <feature.icon />
                </div>
                <h3 className="text-[15px] font-medium text-mist-50">{feature.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-mist-500">
                  {feature.body}
                </p>
              </div>
            </SpotlightCard>
          </Reveal>
        ))}
      </div> */}
    </Section>
  );
}

/* Icons are drawn inline rather than pulled from a set: six shapes at one
   stroke weight, and no icon dependency for a landing page. */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IdIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden {...stroke}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="9" cy="11" r="2" />
      <path d="M6 16c.6-1.4 1.7-2 3-2s2.4.6 3 2M14.5 10h4M14.5 13.5h2.5" />
    </svg>
  );
}

function GateIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden {...stroke}>
      <path d="M5 4v16M12 4v16M19 4v16" />
      <path d="M2.5 9.5h5M9.5 9.5h5M16.5 9.5h5" />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden {...stroke}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M8.2 6.9 15.8 11M8.2 17.1 15.8 13" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden {...stroke}>
      <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2.5" />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden {...stroke}>
      <path d="M4 9h11a5 5 0 0 1 0 10h-5" />
      <path d="M7.5 5.5 4 9l3.5 3.5" />
    </svg>
  );
}

function ProofIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden {...stroke}>
      <path d="M12 3 4.5 6.2v5.3c0 4.3 3.1 7.7 7.5 8.8 4.4-1.1 7.5-4.5 7.5-8.8V6.2L12 3Z" />
      <path d="M9 12.2 11.2 14.4 15.4 10" />
    </svg>
  );
}
