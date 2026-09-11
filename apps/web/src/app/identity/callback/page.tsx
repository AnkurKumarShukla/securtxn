// Where DigiLocker sends the human back after they consent.
//
// It carries no authority: the consent lives on DigiLocker's side and the API
// confirms it by polling the session, never by trusting a query parameter on
// this redirect. So this page exists to tell the person the step worked and
// send them back to the console — nothing here is a security boundary.

export const dynamic = "force-dynamic";

export default async function IdentityCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const asText = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  // DigiLocker spells the outcome differently depending on the path taken, so
  // anything that is not clearly a success is reported as "check the console"
  // rather than guessed at.
  const status = asText(params.status) ?? asText(params.code) ?? "";
  const ok = /success|succeed|granted/i.test(status) || Object.keys(params).length > 0;

  return (
    <main style={S.main}>
      <h1 style={S.h1}>{ok ? "Consent captured" : "Consent not confirmed"}</h1>
      <p style={S.p}>
        {ok
          ? "DigiLocker has recorded your consent. Go back to the console tab — it is polling for this and will continue on its own."
          : "Nothing came back that looks like a granted consent. Return to the console and start the identity step again."}
      </p>

      <p style={S.p}>
        <a style={S.link} href="/console">
          Back to the console
        </a>
      </p>

      {Object.keys(params).length > 0 && (
        <>
          <h2 style={S.h2}>What DigiLocker returned</h2>
          <pre style={S.pre}>{JSON.stringify(params, null, 2)}</pre>
        </>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 640, margin: "0 auto", padding: "64px 24px", color: "#e4e4e7" },
  h1: { fontSize: 22, fontWeight: 600, margin: "0 0 12px" },
  h2: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#71717a",
    margin: "28px 0 8px",
  },
  p: { color: "#a1a1aa", fontSize: 14, lineHeight: 1.6, margin: "0 0 14px" },
  link: { color: "#60a5fa" },
  pre: {
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#d4d4d8",
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
};
