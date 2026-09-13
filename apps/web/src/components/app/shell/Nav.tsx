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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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

const COLLAPSE_KEY = "securtxn.nav.collapsed";

export function Nav() {
  const { role, setRole, payee, org } = useApp();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  /**
   * Collapsed to icons, remembered.
   *
   * Read in an effect rather than during render: a value present in
   * localStorage and absent on the server is a hydration mismatch, and React
   * throws the tree away rather than reconciling it. The cost is one frame at
   * the expanded width on load, which is why the width transition is disabled
   * until the stored value has been applied.
   */
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* private mode — the default is fine */
    }
    setHydrated(true);
  }, []);

  // The content gutter is CSS, driven by this attribute, because the layout
  // that owns the gutter renders on the server and cannot read browser state.
  useEffect(() => {
    const root = document.documentElement;
    if (collapsed) root.dataset.nav = "collapsed";
    else delete root.dataset.nav;
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* nothing to do */
      }
      return next;
    });
  }, []);

  /**
   * Which view the CURRENT route belongs to.
   *
   * DERIVED, NOT STORED, and that is what removes the flicker rather than
   * merely reducing it. Computing this during render means the list and the
   * page change in the same frame; setting state from an effect meant the route
   * landed, the old list painted once, and the correct one arrived a render
   * later — a flash on every switch even after the double-flip was fixed.
   *
   * A deep link therefore decides the view outright. Arriving at the escrow
   * screen with the paying navigation showing is a state nobody chose, and the
   * first thing it does is hide the link back to where you are.
   *
   * Nothing about identity changes here. Both views are the same account, the
   * same wallet and the same verification; this only decides which set of
   * screens is listed.
   */
  const view: Role = useMemo(() => {
    if (PAYEE_ROUTES.some((r) => pathname.startsWith(r))) return "payee";
    // The account screen belongs to both, so it keeps whichever view you
    // arrived in rather than snapping back to paying.
    if (pathname.startsWith("/app/account")) return role;
    if (pathname.startsWith("/app")) return "payer";
    return role;
  }, [pathname, role]);

  // Persisted AFTER the fact, so the preference survives a reload without
  // being in the path that decides what is on screen.
  useEffect(() => {
    if (view !== role) setRole(view);
  }, [view, role, setRole]);

  // Split by what you are DOING versus what you are looking up. Payments and
  // approvals are today's queue; payees and anchors are reference material you
  // go to on purpose.
  const groups: Group[] =
    view === "payer"
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
          // A plain scrim. The blur was defocusing a page nobody is reading —
          // the drawer covers most of it — for the price of a compositor
          // layer over the whole viewport on the devices least able to
          // afford one.
          className="fixed inset-0 z-40 bg-ink-950/80 lg:hidden"
        />
      )}

      {/* AN OBJECT ON THE PAGE, not a wall at the edge of it.
          SHADOW SCALES WITH HEIGHT ABOVE THE SURFACE, NOT WITH SIZE. The docked
          rail barely floats, so it takes the control-level shadow: a 4px offset
          and a 10px blur. It had the dialog-level one — 16px and 44px — which is
          right for something sitting over a scrim and, stretched down a whole
          viewport, produced a dark halo the width of a thumb down the side of
          the page. A big object needs a TIGHTER shadow than a small one at the
          same elevation, not a bigger one.

          Below `lg` it is an overlay drawer genuinely floating over the page,
          so there it keeps the deep one.
          Inset on all four sides with its own radius and its own shadow, so the
          ground is visible around it and it reads as something placed on the
          surface rather than a region the surface stops at. That is the whole
          difference between chrome and a component, and it is what lets the
          same extrusion language apply to the rail as to every card. */}
      <nav
        className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl bg-ink-900 shadow-(--shadow-neu-4) lg:shadow-(--shadow-neu-2) inset-y-3 left-3 ${
          hydrated ? "transition-[transform,width] duration-[--dur-base] ease-[--ease-out-quint]" : ""
        } ${collapsed ? "w-[76px]" : "w-64"} ${open ? "translate-x-0" : "-translate-x-[calc(100%+1rem)]"} lg:translate-x-0`}
      >
        {/* A single soft fall of light down the rail's first stretch, agreeing
            with the global top-left source. Without it a tall slab of one flat
            colour reads as a hole in the page rather than a surface. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-linear-to-b from-white/2.5 to-transparent"
        />

        <div
          className={`relative flex h-14 shrink-0 items-center gap-2 hairline-b ${
            collapsed ? "justify-center px-0" : "px-4"
          }`}
        >
          <Link
            href="/"
            title="SecurTxn"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-mist-50"
          >
            {/* Accent-filled, so it is one of the few things permitted to glow. */}
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-xs bg-signal-400 text-ink-950 shadow-(--glow-signal)">
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 2 3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4L8 2Z" />
                <path d="M6 8.2 7.4 9.6 10.2 6.6" />
              </svg>
            </span>
            {!collapsed && "SecurTxn"}
          </Link>
        </div>

        {/* Which company you are acting as. Named rather than a generic
            "Sender", so the payments below are visibly someone's. */}
        <div className={`relative hairline-b py-3 ${collapsed ? "px-2" : "px-3"}`}>
          <RoleSwitch
            collapsed={collapsed}
            role={view}
            onChange={(next) => {
              // NAVIGATE ONLY. Setting the role here as well is what made the
              // switch flicker: the role changed immediately, the effect below
              // then fired while `pathname` was STILL the old route, decided
              // the role disagreed with it and set it back — and the route
              // finally landed and flipped it a third time. Two visible flips
              // per click, from three renders fighting over one value.
              //
              // The URL is the source of truth, so let it be the only thing
              // that moves. The effect derives the view once the route settles.
              router.push(next === "payee" ? "/app/inbox" : "/app");
              setOpen(false);
            }}
          />
          {!collapsed && (
            <p className="mt-2 truncate px-1 text-2xs text-mist-500">
              {org.displayName ?? "Account not set up yet"}
            </p>
          )}
        </div>

        <div className="relative flex-1 space-y-5 overflow-y-auto p-3">
          {groups.map((group) => (
            <div key={group.label}>
              {collapsed ? (
                // A heading with no room for its word still has a job: it keeps
                // the two halves of the list from reading as one.
                <div aria-hidden className="mx-2 mb-2 h-px bg-hairline" />
              ) : (
                <p className="mb-1.5 px-3 font-mono text-micro tracking-micro text-mist-600 uppercase">
                  {group.label}
                </p>
              )}
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
                        title={collapsed ? item.label : undefined}
                        className={`group/nav relative flex items-center rounded-md py-2 text-sm transition-[box-shadow,background-color,color] duration-[--dur-press] ease-[--ease-standard] ${
                          collapsed ? "justify-center px-0" : "gap-2.5 px-3"
                        } ${
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
                        {!collapsed && <span className="flex-1">{item.label}</span>}
                        {item.badge !== undefined && item.badge > 0 && (
                          <span
                            className={
                              collapsed
                                ? // No room beside the glyph, so it sits on it.
                                  "absolute top-1 right-1 h-2 w-2 rounded-full bg-pending-400"
                                : "neu-1 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-ink-850 px-1.5 font-mono text-micro text-pending-400 tabular-nums"
                            }
                          >
                            {collapsed ? "" : item.badge}
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
        <div className={`relative shrink-0 space-y-2 ${collapsed ? "p-2" : "p-3"}`}>
          <div
            className={`neu-2 rounded-md bg-ink-850 ${collapsed ? "flex justify-center py-2.5" : "px-3 py-2.5"}`}
            title={collapsed ? "Hedera testnet" : undefined}
          >
            <span className="flex items-center gap-2 font-mono text-micro tracking-micro text-mist-500 uppercase">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-pending-400 shadow-(--glow-pending)"
              />
              {!collapsed && "Hedera testnet"}
            </span>
          </div>

          {/* Desktop only. Below `lg` the rail is a drawer that is already
              either open or gone, and a control that narrows something you
              dismiss by tapping beside it is one state too many. */}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand" : "Collapse"}
            className={`neu-2 hidden h-8 w-full items-center justify-center rounded-md bg-ink-850 text-mist-500 transition-[box-shadow,color] duration-[--dur-press] ease-[--ease-standard] hover:text-mist-200 active:neu-in-1 lg:flex`}
          >
            <svg
              viewBox="0 0 16 16"
              className={`h-3.5 w-3.5 transition-transform duration-[--dur-base] ease-[--ease-standard] ${
                collapsed ? "rotate-180" : ""
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M10 3.5 5.5 8l4.5 4.5" />
            </svg>
          </button>
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
function RoleSwitch({
  role,
  onChange,
  collapsed = false,
}: {
  role: Role;
  onChange: (r: Role) => void;
  collapsed?: boolean;
}) {
  // Collapsed, there is no room for a two-up track — so it becomes one button
  // showing the side you are NOT on, which is the only thing pressing it can
  // do. A two-state control with one visible state has to say what the press
  // achieves, not what is currently true.
  if (collapsed) {
    const next: Role = role === "payer" ? "payee" : "payer";
    return (
      <button
        type="button"
        onClick={() => onChange(next)}
        title={next === "payee" ? "Switch to getting paid" : "Switch to paying"}
        aria-label={next === "payee" ? "Switch to getting paid" : "Switch to paying"}
        className="neu-2 flex h-9 w-full items-center justify-center rounded-md bg-ink-850 font-mono text-micro tracking-micro text-mist-400 uppercase transition-[box-shadow,color] duration-[--dur-press] ease-[--ease-standard] hover:text-mist-100 active:neu-in-1"
      >
        {role === "payer" ? "PAY" : "GET"}
      </button>
    );
  }

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
              ? "bg-signal-400 text-ink-950 shadow-[var(--shadow-neu-1),var(--glow-signal)]"
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
