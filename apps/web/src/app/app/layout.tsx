// The product shell.
//
// ROUTE NOTE. `next.config.mjs` proxies a list of top-level prefixes straight
// to the API process using `beforeFiles` rewrites, which silently shadow any
// Next page at the same path. That is why `/payments`, `/approvals` and
// `/evidence` cannot host UI, and why every screen here is nested under `/app`
// instead — `/app/payments` matches no proxy rule. Adding any prefix beginning
// with "app" to `API_PREFIXES` would take this whole product down without an
// error appearing anywhere.
//
// The background is static on purpose. The landing page can justify a WebGL
// raymarch; a screen someone reads a settlement amount off cannot, and a moving
// backdrop behind changing numbers makes them harder to read, not easier.
//
// GROUND, NOT MESH. The product's base plane is matte charcoal, because soft
// extrusion needs a light shadow and a dark shadow to BOTH have somewhere to go
// and a near-black ground gives the light one no room. The old `mesh` and
// `grid-veil` pair is gone from here: a grid texture underneath extruded objects
// is a second depth system arguing with the first. Both utilities survive for
// the landing page, which is still made of the other material.

import type { Metadata } from "next";
import { AppProvider } from "../../components/app/AppProvider";
import { Nav } from "../../components/app/shell/Nav";

export const metadata: Metadata = {
  title: "SecurTxn",
  description:
    "Verified payouts: identity, consent, decision, approval and recoverable settlement.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // The provider sits ABOVE the children so it survives navigation between
    // them — the agent token is minted once, and the payee's five-second poll
    // keeps running while someone is on a different screen.
    <AppProvider>
      <div className="relative min-h-screen">
        {/*
          Applied BEFORE first paint.
          Reading the stored width in an effect would render the expanded
          gutter, then snap to the collapsed one — a visible jump on every page
          load for anyone who collapsed the rail. This touches no React state;
          the rail re-applies the same attribute after mount.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('securtxn.nav.collapsed')==='1')" +
              "document.documentElement.dataset.nav='collapsed'}catch(e){}",
          }}
        />
        <div aria-hidden className="ground pointer-events-none fixed inset-0 -z-10" />

        <Nav />

        {/* Reads the variable the rail stamps on the document element. */}
        <main className="lg:pl-(--nav-gutter)">
          <div className="mx-auto w-full max-w-[1400px] px-4 pt-16 pb-16 sm:px-6 lg:pt-8">
            {children}
          </div>
        </main>
      </div>
    </AppProvider>
  );
}
