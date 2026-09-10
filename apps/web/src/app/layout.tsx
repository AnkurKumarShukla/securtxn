// Root layout.
//
// The font is loaded through next/font so it is self-hosted and preloaded
// rather than fetched from a third party at runtime — one fewer external
// request on a page that talks about not trusting external assertions.
//
// Spec: docs/architecture.md §7

import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "../styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "SecurTxn — Stablecoin payouts that cannot go to the wrong wallet",
  description:
    "A control layer in front of stablecoin payouts: verified payees, human approval, and escrowed settlement that returns the money if nobody claims it.",
  openGraph: {
    title: "SecurTxn",
    description:
      "Verify the payee. Then make the payment recoverable. Built on Hedera.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#050609",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The palette is dark-only and says so, so form controls and scrollbars
    // render to match instead of defaulting to a light chrome.
    <html lang="en" className={`${inter.variable} dark`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
