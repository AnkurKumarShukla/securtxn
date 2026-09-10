"use client";

import Link from "next/link";
import ShinyText from "../reactbits/ShinyText";
import { Reveal } from "./Reveal";
import { FadedRule, GhostButton, PrimaryButton } from "./primitives";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Payments", href: "/payments" },
      { label: "Approvals", href: "/approvals" },
      { label: "Evidence", href: "/evidence" },
      { label: "Exceptions", href: "/exceptions" },
    ],
  },
  {
    heading: "Explore",
    links: [
      { label: "The problem", href: "#problem" },
      { label: "The solution", href: "#solution" },
      { label: "How it works", href: "#how" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-white/[0.05] bg-ink-950">
      {/* The closing ask. Given its own band so it is not read as part of the
          link columns underneath. */}
      <div className="relative overflow-hidden px-6 py-24 lg:px-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal-500/40 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-72 w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal-500/[0.09] blur-3xl"
        />

        <Reveal>
          <div className="relative mx-auto max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-semibold leading-tight text-mist-50 sm:text-4xl">
              Send it once. Know it arrived.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-pretty text-sm leading-relaxed text-mist-400 sm:text-base">
              Verified payees, human approval, and settlement that comes back
              when nobody claims it.
            </p>
            <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <PrimaryButton href="/payments">Launch App</PrimaryButton>
              <GhostButton href="#how">See how it works</GhostButton>
            </div>
          </div>
        </Reveal>
      </div>

      <FadedRule />

      <div className="mx-auto w-full max-w-6xl px-6 py-14 lg:px-8">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
                <path
                  d="M12 2.5 20 6v6.2c0 4.6-3.2 8.2-8 9.3-4.8-1.1-8-4.7-8-9.3V6l8-3.5Z"
                  fill="none"
                  stroke="var(--color-signal-400)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="11" r="2.1" fill="var(--color-signal-400)" />
                <path
                  d="M12 13.1v3.1"
                  stroke="var(--color-signal-400)"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-[15px] font-semibold tracking-tight text-mist-50">
                SecurTxn
              </span>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-mist-500">
              A control layer in front of stablecoin payouts. Confirmed payee,
              recoverable settlement, evidence anyone can check.
            </p>

            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.02] px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-verified-400" />
              <ShinyText
                text="Built on Hedera"
                speed={5}
                color="#6f7889"
                shineColor="#d6dbe6"
                className="font-mono text-[10px] uppercase tracking-[0.16em]"
              />
            </div>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.heading}>
              <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-mist-600">
                {column.heading}
              </h3>
              <ul className="mt-5 space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-mist-400 transition-colors hover:text-mist-50"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <FadedRule className="mt-14" />

        <div className="mt-6 flex flex-col items-start justify-between gap-3 text-xs text-mist-600 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} SecurTxn. All rights reserved.</p>
          <p className="font-mono">
            Hedera testnet · <span className="text-mist-500">not for production value</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
