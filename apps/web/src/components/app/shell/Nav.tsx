"use client";

// The product navigation.
//
// A sidebar, not a top bar. There are two role-dependent sets of destinations
// and one of them carries a live count; a horizontal bar makes both cramped,
// and every accounts-payable tool a user has already seen puts this on the
// left. Below the large breakpoint it becomes an off-canvas slide-over.
//
// THE MATERIAL, and the two rules it follows.
//
//   RAISED MEANS LIVE, RECESSED MEANS CONTAINER. The rail itself is a channel
//   cut into the base plane — darker than the page, so everything placed in it
//   has somewhere to rise from. The destination you are on is the one raised
//   object in the list; the rest are flush, and lift only under the pointer.
//   Selected-and-raised rather than selected-and-pressed is the reading every
//   soft-UI control people already know uses: the chosen tab stands proud of
//   its track, it does not sink below it.
//
//   THE RAIL DOES NOT BLUR. It is fixed and it has the page behind it, so the
//   instinct is frosted glass — but what is actually behind it is a flat
//   charcoal ground with one soft gradient on it, and blurring a smooth
//   gradient produces a pixel-identical result. The cost is a full-height
//   compositor layer that repaints every time the badge count ticks, which is
//   every five seconds, forever. Permanent structural chrome should not
//   shimmer. The mobile drawer is the same surface for the same reason.
//
// Collapse-to-icons, persisted group state and the move of the role switch up
// into a top bar are the next piece of shell work, not this one. What changed
// here is the material and the grouping.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../AppProvider";
import type { Role } from "../../../lib/account";

type Item = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Live count, e.g. payments waiting on the payee. */
  badge?: number | undefined;
};

/** Destinations under a heading. Five flat links is a list; two groups is a
    structure, and it is what lets the eye skip to the half it wants. */
type Group = { label: string; items: Item[] };

/**
 * Screens that belong to the receiving half.
 *
 * The account screen is in NEITHER list, deliberately. It is one account that
 * pays and is paid, so its setup belongs to both views and arriving there must
 * not flip which one you are in.
 */
const PAYEE_ROUTES = ["/app/inbox", "/app/escrow"];

export function Nav() {
  const { role, setRole, payee, org } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // A deep link decides the VIEW, not the stored preference. Arriving at the
  // escrow screen with the paying navigation showing is a state nobody chose,
  // and the first thing it does is hide the link back to where you are.
  //
  // Nothing about identity changes here. Both views are the same account, the
  // same wallet and the same verification; this only decides which set of
  // screens is listed.
  useEffect(() => {
    const wantsPayee = PAYEE_ROUTES.some((r) => pathname.startsWith(r));
    if (wantsPayee && role !== "payee") setRole("payee");
    // The account screen belongs to both views, so landing on it leaves the
    // current one alone rather than snapping back to paying.
    const shared = pathname.startsWith("/app/account");
    if (!wantsPayee && !shared && pathname.startsWith("/app") && role !== "payer") setRole("payer");
  }, [pathname, role, setRole]);

  // Split by what you are DOING versus what you are looking up. Payments and
  // approvals are today's queue; payees and anchors are reference material you
  // go to on purpose.
  const groups: Group[] =
    role === "payer"
      ? [
          {
            label: "Work",
            items: [
              { href: "/app", label: "Overview", icon: <IconHome /> },
              { href: "/app/payments", label: "Payments", icon: <IconPayments /> },
              { href: "/app/approvals", label: "Approvals", icon: <IconApprovals /> },
            ],
          },
          {
            label: "Records",
            items: [
              { href: "/app/payees", label: "Payees", icon: <IconPayees /> },
              { href: "/app/audit", label: "Audit", icon: <IconAudit /> },
            ],
          },
          {
            label: "You",
            items: [{ href: "/app/account", label: "Account", icon: <IconIdentity /> }],
          },
        ]
      : [
          {
            label: "Work",
            items: [
              {
                href: "/app/inbox",
                label: "Incoming",
                icon: <IconInbox />,
                badge: payee.incoming.length,
              },
              { href: "/app/escrow", label: "Escrow", icon: <IconEscrow /> },
            ],
          },
          {
            label: "You",
            items: [{ href: "/app/account", label: "Account", icon: <IconIdentity /> }],
          },
        ];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="neu-2 fixed top-3 left-3 z-50 inline-flex h-9 w-9 items-center justify-center rounded-md bg-ink-800 text-mist-200 transition-shadow duration-[--dur-press] active:neu-in-1 lg:hidden"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
        </svg>
      </button>

      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-ink-950/70 backdrop-blur-sm lg:hidden"
        />
      )}

      <nav
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-ink-900 shadow-(--shadow-neu-4) transition-transform duration-[--dur-base] ease-[--ease-out-quint] lg:translate-x-0 lg:shadow-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* A single soft fall of light down the rail's first stretch, agreeing
            with the global top-left source. Without it a 100vh slab of one flat
            colour reads as a hole in the page rather than a surface. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-linear-to-b from-white/2.5 to-transparent"
        />
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-px bg-hairline-strong" />

        <div className="relative flex h-14 shrink-0 items-center gap-2 hairline-b px-4">
          <Link
            href="/"
            className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-mist-50"
          >
            {/* Accent-filled, so it is one of the few things permitted to glow. */}
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-xs bg-linear-to-b from-signal-400 to-signal-600 text-ink-950 shadow-(--glow-signal)">
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4L8 2Z" />
                <path d="M6 8.2 7.4 9.6 10.2 6.6" />
              </svg>
            </span>
            SecurTxn
          </Link>
        </div>

        {/* Which company you are acting as. Named rather than a generic
            "Sender", so the payments below are visibly someone's. */}
        <div className="relative hairline-b px-3 py-3">
          <RoleSwitch
            role={role}
            onChange={(next) => {
              setRole(next);
              router.push(next === "payee" ? "/app/inbox" : "/app");
              setOpen(false);
            }}
          />
          <p className="mt-2 truncate px-1 text-[11px] text-mist-500">
            {org.displayName ?? "Account not set up yet"}
          </p>
        </div>

        <div className="relative flex-1 space-y-5 overflow-y-auto p-3">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-1.5 px-3 font-mono text-micro tracking-micro text-mist-600 uppercase">
                {group.label}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  // Exact match for the index route, prefix match for the rest,
                  // so /app/payments/new still highlights Payments.
                  const active =
                    item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        aria-current={active ? "page" : undefined}
                        // The shadow morph IS the state change here. 140ms, and
                        // only on the item under the pointer — box-shadow is not
                        // compositor-accelerated, so animating a whole list of
                        // them drops frames.
                        className={`group/nav relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-[box-shadow,background-color,color] duration-[--dur-press] ease-[--ease-standard] ${
                          active
                            ? "neu-2 bg-ink-800 text-signal-300"
                            : "text-mist-400 hover:neu-1 hover:bg-ink-850 hover:text-mist-100 active:neu-in-1"
                        }`}
                      >
                        {/* Where you are, said a second way. The extrusion is
                            affordance; this bar is the information, and it
                            survives the shadows being switched off. */}
                        {active && (
                          <span
                            aria-hidden
                            className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-signal-400 shadow-(--glow-signal)"
                          />
                        )}
                        <span className={active ? "text-signal-400" : "text-mist-500"}>
                          {item.icon}
                        </span>
                        <span className="flex-1">{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className="neu-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ink-850 px-1.5 font-mono text-micro text-pending-400 tabular-nums">
                            {item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Raised out of the rail rather than ruled off from it. What goes wrong
            in this product is the network and the API, so that is what earns the
            one pinned card — see the shell plan for wiring reachability in. */}
        <div className="relative shrink-0 p-3">
          <div className="neu-2 rounded-md bg-ink-850 px-3 py-2.5">
            <span className="flex items-center gap-2 font-mono text-micro tracking-micro text-mist-500 uppercase">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-pending-400 shadow-(--glow-pending)"
              />
              Hedera testnet
            </span>
          </div>
        </div>
      </nav>
    </>
  );
}

/**
 * Payer or payee.
 *
 * The two sides are genuinely different companies and in production would be
 * different logins. One browser holds both so a single machine can demonstrate
 * the whole flow, which is the only reason this switch exists.
 */
function RoleSwitch({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  return (
    // A recessed track holding one raised, accent-filled thumb. The track is a
    // container, so it sinks; the chosen side is live, so it rises out of it.
    <div className="well grid grid-cols-2 gap-1 p-1">
      {(["payer", "payee"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={role === value}
          className={`rounded-xs py-1.5 text-xs font-medium transition-[box-shadow,background-color,color] duration-[--dur-press] ease-[--ease-standard] ${
            role === value
              // One declaration, not `neu-1` plus a glow class: both set
              // box-shadow, so the second would simply replace the first.
              ? "bg-linear-to-b from-signal-400 to-signal-600 text-ink-950 shadow-[var(--shadow-neu-1),var(--glow-signal)]"
              : "text-mist-400 hover:bg-ink-850 hover:text-mist-100"
          }`}
        >
          {value === "payer" ? "Paying" : "Getting paid"}
        </button>
      ))}
    </div>
  );
}

/* Icons are drawn inline at one stroke weight rather than pulled from a set.
   Eight shapes do not justify an icon dependency. */
const s = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const C = "h-4 w-4";

function IconHome() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <path d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7Z" />
      <path d="M6.5 14V9.5h3V14" />
    </svg>
  );
}
function IconPayments() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <rect x="1.8" y="3.5" width="12.4" height="9" rx="1.5" />
      <path d="M1.8 6.6h12.4M4.5 9.8h2.5" />
    </svg>
  );
}
function IconPayees() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <circle cx="6" cy="6" r="2.4" />
      <path d="M2 13c.7-2 2.2-3 4-3s3.3 1 4 3M11 5.2a2 2 0 0 1 0 3.6M12.8 12.6c-.3-1-.8-1.8-1.5-2.3" />
    </svg>
  );
}
function IconApprovals() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5.6 8.2 7.2 9.8l3.2-3.4" />
    </svg>
  );
}
function IconAudit() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <path d="M8 1.8 3 3.9v3.6c0 2.9 2.1 5.2 5 6 2.9-.8 5-3.1 5-6V3.9L8 1.8Z" />
      <path d="M6 8.2 7.4 9.6 10.2 6.6" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <path d="M2 8.5h3l1 2h4l1-2h3" />
      <path d="M2.6 4.2 2 8.5v3.3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8.5l-.6-4.3a1 1 0 0 0-1-.8H3.6a1 1 0 0 0-1 .8Z" />
    </svg>
  );
}
function IconEscrow() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7M8 9.6v1.4" />
    </svg>
  );
}
function IconIdentity() {
  return (
    <svg viewBox="0 0 16 16" className={C} aria-hidden {...s}>
      <rect x="2" y="3.2" width="12" height="9.6" rx="1.5" />
      <circle cx="6" cy="7" r="1.5" />
      <path d="M3.8 11c.5-1 1.3-1.5 2.2-1.5s1.7.5 2.2 1.5M9.8 6.4h2.6M9.8 8.8h1.8" />
    </svg>
  );
}
