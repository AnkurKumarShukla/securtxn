// Root layout. Phase 3 (docs/architecture.md §7).
import "../styles/globals.css";

export const metadata = { title: "Confirmed Payee" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
