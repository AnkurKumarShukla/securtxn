// The SecurTxn landing page.
//
// Five sections, in the order the argument runs: what we do, why it is needed,
// how it is built, how it runs, and where to go next.
//
// The nav lives inside the hero rather than at page level: CardNav positions
// itself absolutely, so it needs the hero as its containing block to sit over
// the prism instead of over the top of the document.
//
// WHY THE WRAPPER. The product and the marketing page are deliberately made of
// different material: the app is matte charcoal with soft extrusion, this page
// is deep black with frosted glass over a WebGL prism. `data-surface="deep"`
// restores the original surface ramp and type scale for this subtree only, so
// the app's tokens can move without dragging the marketing page with them.
//
// `display: contents` rather than a styled div: the element carries the custom
// properties down the tree but is not a box, so it cannot introduce a stacking
// context or a containing block that the hero's absolutely positioned nav would
// then resolve against.
//
// Spec: docs/architecture.md §7

import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Problem } from "@/components/landing/Problem";
import { Solution } from "@/components/landing/Solution";

export default function LandingPage() {
  return (
    <div data-surface="deep" style={{ display: "contents" }}>
      <main>
        <Hero />
        <Problem />
        <Solution />
        <HowItWorks />
      </main>
      <Footer />
    </div>
  );
}
