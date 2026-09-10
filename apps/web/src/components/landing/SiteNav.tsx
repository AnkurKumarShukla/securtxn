"use client";

import CardNav, { type CardNavItem } from "../reactbits/CardNav";

/**
 * The site nav, configured as smoked glass.
 *
 * Dark fills, but never opaque. What makes these read as glass is not the fill
 * at all — it is the blur, the light border, the top rim and the sheen, which
 * CardNav applies when `glass` is set. The fill only decides how smoked the
 * pane is. A white film worked too, but reads as a lighter object sitting on a
 * dark page; smoked glass reads as part of it.
 *
 * The number that matters is the alpha. Push it past roughly 0.7 and the blur
 * has nothing left to show, at which point this is just a dark bar with a
 * border.
 *
 * Values are rgba rather than Tailwind tokens because the component styles
 * through inline `style` and cannot read one.
 *
 * Cards sit a little denser than the bar. They hold links that have to stay
 * readable over a moving render, and glass that swallows its own text is
 * decoration rather than navigation.
 */
const ITEMS: CardNavItem[] = [
  {
    label: "Why",
    bgColor: "rgba(10, 13, 20, 0.55)",
    textColor: "#f5f7fa",
    links: [
      { label: "The problem", href: "#problem", ariaLabel: "The problem we solve" },
      { label: "The solution", href: "#solution", ariaLabel: "How SecurTxn solves it" },
    ],
  },
  {
    label: "How",
    bgColor: "rgba(14, 18, 27, 0.55)",
    textColor: "#f5f7fa",
    links: [
      { label: "How it works", href: "#how", ariaLabel: "How it works" },
      { label: "Security model", href: "#solution", ariaLabel: "The security model" },
    ],
  },
  {
    // Tinted toward the accent, so the card that leads into the product is the
    // one the eye lands on last. Still smoked, just smoked blue.
    label: "App",
    bgColor: "rgba(22, 36, 72, 0.58)",
    textColor: "#f5f7fa",
    links: [
      { label: "Payments", href: "/payments", ariaLabel: "Open payments" },
      { label: "Approvals", href: "/approvals", ariaLabel: "Open the approval queue" },
      { label: "Evidence", href: "/evidence", ariaLabel: "Open the evidence viewer" },
    ],
  },
];

export function SiteNav() {
  return (
    <CardNav
      logo="/logo.svg"
      logoAlt="SecurTxn"
      items={ITEMS}
      glass
      baseColor="rgba(7, 9, 14, 0.5)"
      menuColor="#f5f7fa"
      // The call to action stays solid. It is the one thing on the bar that
      // should not recede into the background.
      buttonBgColor="#5b8cff"
      buttonTextColor="#050609"
      ctaLabel="Launch App"
      ctaHref="/payments"
      ease="power3.out"
      className="card-nav-securtxn"
    />
  );
}
