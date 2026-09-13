// A sign on a door nobody should walk through.
//
// `/console` and `/payee` predate the product UI at `/app`. They are kept only
// until every path they exercise is confirmed covered — `/payee`'s escrow claim
// and `/console`'s standalone World ID surface are the two still being checked —
// and then both are deleted.
//
// Until then they are a hazard, because they LOOK like the product and they are
// not built like it: every style in them is an inline `React.CSSProperties`
// object over raw hex, with their own status-colour maps that contradict
// `components/ui/status.ts`. Anyone who opens one of these files to learn "how
// this app does things" learns the opposite of the answer.
//
// Deliberately not styled with the design system. A banner that says "do not
// copy from this file" and is itself an example worth copying is a mixed
// message, and this component is deleted with the pages it marks.
//
// Development only. These pages are not linked from the product, and shipping a
// maintenance notice to anyone who finds one by URL in production would be
// noise — the pages still work, they are just not the way in.

const WRAP: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 100,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "0 10px",
  padding: "8px 14px",
  borderBottom: "1px solid #7c2d12",
  background: "#431407",
  color: "#fed7aa",
  font: "500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
};

const STRONG: React.CSSProperties = { color: "#ffedd5", fontWeight: 700 };

export function LegacyBanner({ page, instead }: { page: string; instead: string }) {
  if (process.env.NODE_ENV === "production") return null;

  return (
    <div style={WRAP} role="note">
      <span style={STRONG}>Legacy {page}.</span>
      <span>
        Not the product UI — that is <code>{instead}</code>. Scheduled for deletion. Do not copy
        patterns from this file; it uses inline styles and its own colour map.
      </span>
    </div>
  );
}
