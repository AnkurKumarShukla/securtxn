// Where DigiLocker sends the human back after they consent.
//
// It carries no authority: the consent lives on DigiLocker's side and the API
// confirms it by polling the session, never by trusting a query parameter on
// this redirect. So this page exists to tell the person the step worked and
// send them back to the dashboard — nothing here is a security boundary.

import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function IdentityCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const asText = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  // DigiLocker spells the outcome differently depending on the path taken, so
  // anything that is not clearly a success is reported as "check the dashboard"
  // rather than guessed at.
  const status = asText(params.status) ?? asText(params.code) ?? "";
  const ok = /success|succeed|granted/i.test(status) || Object.keys(params).length > 0;

  return (
    <div className="relative min-h-screen">
      <div aria-hidden className="ground pointer-events-none fixed inset-0 -z-10" />

      <main className="mx-auto w-full max-w-2xl px-6 py-24">
        <div className="panel p-7">
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                ok ? "bg-verified-400/12 text-verified-400" : "bg-pending-400/12 text-pending-400"
              }`}
            >
              {ok ? (
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3.5 8.5 6.5 11.5 12.5 5" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M8 4v5M8 11.3v.3" />
                </svg>
              )}
            </span>

            <div className="min-w-0">
              <h1 className="text-[20px] font-semibold tracking-tight text-mist-50">
                {ok ? "Consent captured" : "Consent not confirmed"}
              </h1>
              <p className="mt-2 text-[13.5px] leading-relaxed text-mist-400">
                {ok
                  ? "DigiLocker has recorded your consent. Go back to the dashboard tab — it is polling for this and will continue on its own."
                  : "Nothing came back that looks like a granted consent. Return to the dashboard and start the identity step again."}
              </p>

              <div className="mt-5 flex flex-wrap gap-2">
                <Link
                  href="/app"
                  className="inline-flex h-9 items-center rounded-md bg-signal-400 px-4 text-[13px] font-medium text-ink-950 shadow-[0_1px_0_0_rgba(255,255,255,0.28)_inset] transition-colors hover:bg-signal-300"
                >
                  Back to the dashboard
                </Link>
                {/* The original console still works, and an already-open
                    DigiLocker tab may have been launched from it. */}
                <Link
                  href="/console"
                  className="inline-flex h-9 items-center rounded-md hairline-strong bg-white/[0.045] px-4 text-[13px] text-mist-200 transition-colors hover:border-hairline-active hover:text-mist-50"
                >
                  The old console
                </Link>
              </div>
            </div>
          </div>

          {Object.keys(params).length > 0 && (
            <div className="mt-7">
              <p className="mb-2 font-mono text-[10.5px] tracking-[0.16em] text-mist-500 uppercase">
                What DigiLocker returned
              </p>
              <pre className="well max-h-72 overflow-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-mist-300">
                {JSON.stringify(params, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
