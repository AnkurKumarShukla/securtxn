// Vendored from React Bits (reactbits.dev), CardNav / TS-TW variant.
//
// Four changes, all marked ADAPTED:
//
//   1. "use client" — it runs a GSAP timeline against real DOM nodes.
//   2. The arrow icon is inlined. Upstream imports GoArrowUpRight from
//      react-icons, and its own comment says to substitute your own; pulling a
//      whole icon library in for one 16px glyph is not worth the bundle.
//   3. The call-to-action label and href are props. Upstream hardcodes a
//      "Get Started" button that goes nowhere.
//   4. The card links render through next/link when internal, so in-app
//      navigation does not do a full document load.
//
// Upstream: https://reactbits.dev/components/card-nav
// Requires: gsap

"use client"; // ADAPTED

import Link from "next/link";
import React, { useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";

type CardNavLink = {
  label: string;
  href: string;
  ariaLabel: string;
};

export type CardNavItem = {
  label: string;
  bgColor: string;
  textColor: string;
  links: CardNavLink[];
};

export interface CardNavProps {
  logo: string;
  logoAlt?: string;
  items: CardNavItem[];
  className?: string;
  ease?: string;
  baseColor?: string;
  menuColor?: string;
  buttonBgColor?: string;
  buttonTextColor?: string;
  /** ADAPTED: upstream hardcodes "Get Started" and no destination. */
  ctaLabel?: string;
  ctaHref?: string;
  /**
   * ADAPTED: frosted-glass surface.
   *
   * Upstream paints a flat colour. With `glass`, the bar and its cards get a
   * backdrop blur, a hairline edge and a lit top rim, so whatever is behind
   * them shows through softened rather than being covered. Pass translucent
   * `baseColor` and `bgColor` values for it to do anything — a blur behind an
   * opaque fill is invisible.
   *
   * Off by default so upstream's appearance is still what you get without
   * asking for this.
   */
  glass?: boolean;
}

/** ADAPTED: inlined in place of react-icons/go GoArrowUpRight. */
function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  );
}

const CardNav: React.FC<CardNavProps> = ({
  logo,
  logoAlt = "Logo",
  items,
  className = "",
  ease = "power3.out",
  baseColor = "#fff",
  menuColor,
  buttonBgColor,
  buttonTextColor,
  ctaLabel = "Get Started", // ADAPTED
  ctaHref = "#", // ADAPTED
  glass = false, // ADAPTED
}) => {
  const [isHamburgerOpen, setIsHamburgerOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const navRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<HTMLDivElement[]>([]);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  const calculateHeight = () => {
    const navEl = navRef.current;
    if (!navEl) return 260;

    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    if (isMobile) {
      const contentEl = navEl.querySelector(".card-nav-content") as HTMLElement;
      if (contentEl) {
        const wasVisible = contentEl.style.visibility;
        const wasPointerEvents = contentEl.style.pointerEvents;
        const wasPosition = contentEl.style.position;
        const wasHeight = contentEl.style.height;

        contentEl.style.visibility = "visible";
        contentEl.style.pointerEvents = "auto";
        contentEl.style.position = "static";
        contentEl.style.height = "auto";

        void contentEl.offsetHeight;

        const topBar = 60;
        const padding = 16;
        const contentHeight = contentEl.scrollHeight;

        contentEl.style.visibility = wasVisible;
        contentEl.style.pointerEvents = wasPointerEvents;
        contentEl.style.position = wasPosition;
        contentEl.style.height = wasHeight;

        return topBar + contentHeight + padding;
      }
    }
    return 260;
  };

  const createTimeline = () => {
    const navEl = navRef.current;
    if (!navEl) return null;

    gsap.set(navEl, { height: 60, overflow: "hidden" });
    gsap.set(cardsRef.current, { y: 50, opacity: 0 });

    const tl = gsap.timeline({ paused: true });

    tl.to(navEl, {
      height: calculateHeight,
      duration: 0.4,
      ease,
    });

    tl.to(
      cardsRef.current,
      { y: 0, opacity: 1, duration: 0.4, ease, stagger: 0.08 },
      "-=0.1",
    );

    return tl;
  };

  useLayoutEffect(() => {
    const tl = createTimeline();
    tlRef.current = tl;

    return () => {
      tl?.kill();
      tlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ease, items]);

  useLayoutEffect(() => {
    const handleResize = () => {
      if (!tlRef.current) return;

      if (isExpanded) {
        const newHeight = calculateHeight();
        gsap.set(navRef.current, { height: newHeight });

        tlRef.current.kill();
        const newTl = createTimeline();
        if (newTl) {
          newTl.progress(1);
          tlRef.current = newTl;
        }
      } else {
        tlRef.current.kill();
        const newTl = createTimeline();
        if (newTl) {
          tlRef.current = newTl;
        }
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  const toggleMenu = () => {
    const tl = tlRef.current;
    if (!tl) return;
    if (!isExpanded) {
      setIsHamburgerOpen(true);
      setIsExpanded(true);
      tl.play(0);
    } else {
      setIsHamburgerOpen(false);
      tl.eventCallback("onReverseComplete", () => setIsExpanded(false));
      tl.reverse();
    }
  };

  const setCardRef = (i: number) => (el: HTMLDivElement | null) => {
    if (el) cardsRef.current[i] = el;
  };

  return (
    <div
      className={`card-nav-container absolute left-1/2 -translate-x-1/2 w-[90%] max-w-[800px] z-[99] top-[1.2em] md:top-[2em] ${className}`}
    >
      <nav
        ref={navRef}
        className={`card-nav ${isExpanded ? "open" : ""} block h-[60px] p-0 rounded-xl relative overflow-hidden will-change-[height] ${
          glass
            ? // ADAPTED: the frosted bar — smoked glass, not a plain tint.
              //
              // A dark fill alone reads as a black bar. What makes it glass is
              // everything around the fill: the blur, `saturate` so colour
              // behind the pane does not go grey once blurred, a light border,
              // a lit top rim, and a sheen falling from the top edge. Those
              // four are what catch the light; the fill only sets how smoked it
              // is. The sheen is a background-IMAGE, so it layers over the
              // caller's inline background-color rather than replacing it.
              "backdrop-blur-xl backdrop-saturate-[1.7] border border-white/12 bg-linear-to-b from-white/7 via-white/2 to-transparent shadow-[0_10px_36px_-10px_rgba(0,0,0,0.75),inset_0_1px_0_0_rgba(255,255,255,0.16)]"
            : "shadow-md"
        }`}
        style={{ backgroundColor: baseColor }}
      >
        <div className="card-nav-top absolute inset-x-0 top-0 h-[60px] flex items-center justify-between p-2 pl-[1.1rem] z-[2]">
          <div
            className={`hamburger-menu ${isHamburgerOpen ? "open" : ""} group h-full flex flex-col items-center justify-center cursor-pointer gap-[6px] order-2 md:order-none`}
            onClick={toggleMenu}
            onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleMenu();
              }
            }}
            role="button"
            aria-label={isExpanded ? "Close menu" : "Open menu"}
            aria-expanded={isExpanded}
            tabIndex={0}
            style={{ color: menuColor || "#000" }}
          >
            <div
              className={`hamburger-line w-[30px] h-[2px] bg-current transition-[transform,opacity,margin] duration-300 ease-linear [transform-origin:50%_50%] ${
                isHamburgerOpen ? "translate-y-[4px] rotate-45" : ""
              } group-hover:opacity-75`}
            />
            <div
              className={`hamburger-line w-[30px] h-[2px] bg-current transition-[transform,opacity,margin] duration-300 ease-linear [transform-origin:50%_50%] ${
                isHamburgerOpen ? "-translate-y-[4px] -rotate-45" : ""
              } group-hover:opacity-75`}
            />
          </div>

          <div className="logo-container flex items-center md:absolute md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 order-1 md:order-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} alt={logoAlt} className="logo h-[28px]" />
          </div>

          {/* ADAPTED: a real destination, a caller-supplied label, and the same
              surface treatment as the page's primary button — a top-lit
              gradient, an inset rim and an accent-tinted glow. Upstream fades to
              90% opacity on hover, which on a solid button reads as disabled
              rather than interactive; brightness is the right dial. */}
          <Link
            href={ctaHref}
            className={`card-nav-cta-button relative hidden md:inline-flex overflow-hidden border-0 rounded-[calc(0.75rem-0.2rem)] px-5 items-center h-full text-sm font-semibold tracking-[-0.006em] cursor-pointer transition-[filter,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              glass
                ? "bg-linear-to-b from-white/25 to-transparent shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_22px_-10px_rgba(91,140,255,0.9)] hover:brightness-[1.08] hover:shadow-[0_1px_0_0_rgba(255,255,255,0.5)_inset,0_12px_30px_-10px_rgba(91,140,255,1)]"
                : "hover:opacity-90"
            }`}
            style={{ backgroundColor: buttonBgColor, color: buttonTextColor }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[calc(0.75rem-0.2rem)] ring-1 ring-inset ring-white/20"
            />
            <span className="relative">{ctaLabel}</span>
          </Link>
        </div>

        <div
          className={`card-nav-content absolute left-0 right-0 top-[60px] bottom-0 p-2 flex flex-col items-stretch gap-2 justify-start z-[1] ${
            isExpanded ? "visible pointer-events-auto" : "invisible pointer-events-none"
          } md:flex-row md:items-end md:gap-[12px]`}
          aria-hidden={!isExpanded}
        >
          {(items || []).slice(0, 3).map((item, idx) => (
            <div
              key={`${item.label}-${idx}`}
              className={`nav-card select-none relative flex flex-col gap-2 p-[12px_16px] rounded-[calc(0.75rem-0.2rem)] min-w-0 flex-[1_1_auto] h-auto min-h-[60px] md:h-full md:min-h-0 md:flex-[1_1_0%] ${
                glass
                  ? // ADAPTED: a lighter blur than the bar. Matching it would
                    // flatten the two into one pane; a step down in strength is
                    // what makes the cards read as sitting on top of it.
                    "backdrop-blur-md backdrop-saturate-150 border border-white/10 bg-linear-to-b from-white/5 to-transparent shadow-[inset_0_1px_0_0_rgba(255,255,255,0.10)]"
                  : ""
              }`}
              ref={setCardRef(idx)}
              style={{ backgroundColor: item.bgColor, color: item.textColor }}
            >
              <div className="nav-card-label font-normal tracking-[-0.5px] text-[18px] md:text-[22px]">
                {item.label}
              </div>
              <div className="nav-card-links mt-auto flex flex-col gap-[2px]">
                {item.links?.map((lnk, i) => (
                  // ADAPTED: next/link for internal routes, a plain anchor for
                  // in-page hashes, so app navigation is not a full reload.
                  <NavCardLink key={`${lnk.label}-${i}`} link={lnk} onNavigate={toggleMenu} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
};

/** ADAPTED: split out so the internal/external choice is made in one place. */
function NavCardLink({
  link,
  onNavigate,
}: {
  link: CardNavLink;
  onNavigate: () => void;
}) {
  const className =
    "nav-card-link inline-flex items-center gap-[6px] no-underline cursor-pointer transition-opacity duration-300 hover:opacity-75 text-[15px] md:text-[16px]";

  const inner = (
    <>
      <ArrowUpRight className="nav-card-link-icon shrink-0" />
      {link.label}
    </>
  );

  if (link.href.startsWith("#")) {
    return (
      <a className={className} href={link.href} aria-label={link.ariaLabel} onClick={onNavigate}>
        {inner}
      </a>
    );
  }

  return (
    <Link className={className} href={link.href} aria-label={link.ariaLabel}>
      {inner}
    </Link>
  );
}

export default CardNav;
