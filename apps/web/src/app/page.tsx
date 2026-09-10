// The SecurTxn landing page.
//
// Five sections, in the order the argument runs: what we do, why it is needed,
// how it is built, how it runs, and where to go next.
//
// The nav lives inside the hero rather than at page level: CardNav positions
// itself absolutely, so it needs the hero as its containing block to sit over
// the prism instead of over the top of the document.
//
// Spec: docs/architecture.md §7

import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Problem } from "@/components/landing/Problem";
import { Solution } from "@/components/landing/Solution";

export default function LandingPage() {
  return (
    <>
      <main>
        <Hero />
        <Problem />
        <Solution />
        <HowItWorks />
      </main>
      <Footer />
    </>
  );
}
