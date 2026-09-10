"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The payment pipeline, shot as a camera move rather than drawn as a diagram.
 *
 * THE IDEA. A fixed frame is a viewport onto a track that is wider than it. The
 * camera pans so the stage in focus sits centre-frame, and its neighbours are
 * dimmed and cut off at the edges. Not seeing the whole thing at once is the
 * point: it tells you the pipeline continues without asking you to read it all.
 *
 * Three things move together off one index — which node is lit, where the
 * marker sits on the rail, and which artifact card is showing. The artifacts
 * are the payload: what actually travels between stages is more informative
 * than what the stages are called.
 *
 * WHY SVG. It has to stay horizontal and scale, not reflow to a column. A
 * viewBox does that for free. The catch is that scaling down shrinks the text
 * with everything else, so on a narrow screen the frame shows FEWER track units
 * instead — a tighter crop at a readable size, rather than the whole width at
 * an unreadable one.
 *
 * It runs on a loop, like a video. Hovering pauses it, the stage buttons jump,
 * and anyone who has asked their system to stop animation gets a still frame
 * they can step through themselves.
 */

type Artifact = {
  title: string;
  rows: [string, string][];
  /** Renders the card in the verified green instead of the neutral surface. */
  tone?: "signal" | "verified";
};

type Stage = {
  id: string;
  n: string;
  label: string;
  sub: string;
  /** What leaves this stage and travels to the next one. */
  handoff: string;
  /** What falls off the rail here when the stage refuses. */
  refusal: string | null;
  artifact: Artifact;
  /** The line under the frame, once this stage is in focus. */
  outcome: string;
};

const STAGES: Stage[] = [
  {
    id: "verify",
    n: "01",
    label: "VERIFY",
    sub: "identity + wallet",
    handoff: "wallet CONFIRMED",
    refusal: "unverified",
    artifact: {
      title: "VENDOR_WALLET",
      rows: [
        ["document", "signature ok"],
        ["control", "EIP-712 proof"],
        ["callback", "registry contact"],
        ["status", "CONFIRMED"],
      ],
    },
    outcome: "An address nobody can substitute",
  },
  {
    id: "decide",
    n: "02",
    label: "DECIDE",
    sub: "checks, in order",
    handoff: "SAFE_TO_SEND",
    refusal: "DO_NOT_SEND",
    artifact: {
      title: "DECISION",
      rows: [
        ["sanctions", "clear"],
        ["duplicate", "none"],
        ["tier limit", "within"],
        ["verdict", "SAFE_TO_SEND"],
      ],
    },
    outcome: "A verdict with a reason attached",
  },
  {
    id: "approve",
    n: "03",
    label: "APPROVE",
    sub: "a person releases it",
    handoff: "approved",
    refusal: "held",
    artifact: {
      title: "PROPOSAL",
      rows: [
        ["payee", "Meridian Components"],
        ["address", "0x7099…79C8"],
        ["amount", "500.00"],
        ["released by", "approver"],
      ],
    },
    outcome: "No payout an agent can trigger",
  },
  {
    id: "settle",
    n: "04",
    label: "SETTLE",
    sub: "escrow, then a fork",
    handoff: "receipt",
    refusal: "REFUNDED to payer",
    artifact: {
      title: "ESCROW",
      tone: "verified",
      rows: [
        ["hashlock", "published"],
        ["claimed", "preimage revealed"],
        ["unclaimed", "returns at expiry"],
        ["either way", "evidence written"],
      ],
    },
    outcome: "A wrong send stops being permanent",
  },
];

// --- track geometry, in viewBox units -------------------------------------

const SPACING = 400;
const NODE_W = 224;
const NODE_H = 68;
const NODE_Y = 96;
const RAIL_Y = 214;
const CARD_Y = 300;
const CARD_W = 290;
const CARD_H = 150;
const FRAME_H = 476;
const FIRST_X = 260;

const centerOf = (i: number) => FIRST_X + i * SPACING;
const TERMINAL_X = centerOf(STAGES.length - 1) + SPACING;

const DWELL_MS = 4200;

export function PipelineCamera() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  // Narrow screens get a tighter crop rather than a smaller everything.
  const [frameW, setFrameW] = useState(1000);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyMotion = () => setStill(motion.matches);
    applyMotion();
    motion.addEventListener("change", applyMotion);

    const host = hostRef.current;
    const resize = () => {
      const w = host?.clientWidth ?? 1000;
      // Fewer units on a phone means each unit is drawn larger, which is the
      // only way the labels survive at 390px without the layout going vertical.
      setFrameW(w < 560 ? 560 : w < 900 ? 780 : 1000);
    };
    resize();

    const ro = host ? new ResizeObserver(resize) : null;
    if (host && ro) ro.observe(host);

    return () => {
      motion.removeEventListener("change", applyMotion);
      ro?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (paused || still) return;
    const timer = setTimeout(
      () => setActive((i) => (i + 1) % STAGES.length),
      DWELL_MS,
    );
    return () => clearTimeout(timer);
  }, [active, paused, still]);

  const cameraX = frameW / 2 - centerOf(active);
  const stage = STAGES[active]!;

  return (
    <div ref={hostRef}>
      <div
        className="relative overflow-hidden rounded-2xl border border-white/[0.09] bg-ink-950"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div className="pointer-events-none absolute inset-0 grid-veil opacity-30" aria-hidden />

        <svg
          viewBox={`0 0 ${frameW} ${FRAME_H}`}
          className="relative block w-full"
          role="img"
          aria-label={`Payment pipeline, stage ${active + 1} of ${STAGES.length}: ${stage.label}`}
        >
          <defs>
            {/* The edge falloff. Hard-clipping at the frame border looks like a
                bug; fading looks like a camera. */}
            <linearGradient id="pc-fade-l" x1="0" x2="1">
              <stop offset="0" stopColor="#050609" stopOpacity="1" />
              <stop offset="1" stopColor="#050609" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="pc-fade-r" x1="0" x2="1">
              <stop offset="0" stopColor="#050609" stopOpacity="0" />
              <stop offset="1" stopColor="#050609" stopOpacity="1" />
            </linearGradient>
          </defs>

          <g
            transform={`translate(${cameraX} 0)`}
            style={{
              transition: still ? "none" : "transform 1100ms cubic-bezier(0.65, 0, 0.35, 1)",
            }}
          >
            <Rail activeIndex={active} still={still} />

            {STAGES.map((s, i) => (
              <StageGroup key={s.id} stage={s} index={i} active={i === active} />
            ))}

            <Terminal />
          </g>

          <rect x="0" y="0" width="120" height={FRAME_H} fill="url(#pc-fade-l)" />
          <rect
            x={frameW - 120}
            y="0"
            width="120"
            height={FRAME_H}
            fill="url(#pc-fade-r)"
          />

          <text
            x="26"
            y="34"
            className="fill-mist-600 font-mono"
            fontSize="12"
            letterSpacing="2.4"
          >
            SECURTXN · PAYMENT PIPELINE
          </text>
          <text
            x={frameW - 26}
            y="34"
            textAnchor="end"
            className="fill-mist-600 font-mono"
            fontSize="12"
            letterSpacing="1.6"
          >
            {stage.n} / {String(STAGES.length).padStart(2, "0")}
          </text>
        </svg>
      </div>

      <Controls
        active={active}
        paused={paused || still}
        onSelect={setActive}
        outcome={stage.outcome}
      />
    </div>
  );
}

/** The main line, its segment labels, and the drops where a stage refuses. */
function Rail({ activeIndex, still }: { activeIndex: number; still: boolean }) {
  const start = centerOf(0) - 200;

  return (
    <g>
      <line
        x1={start}
        y1={RAIL_Y}
        x2={TERMINAL_X}
        y2={RAIL_Y}
        stroke="currentColor"
        className="text-white/12"
        strokeWidth="1.5"
      />

      {/* The lit portion: everything the payment has already passed through. */}
      <line
        x1={start}
        y1={RAIL_Y}
        x2={centerOf(activeIndex)}
        y2={RAIL_Y}
        stroke="currentColor"
        className="text-signal-500"
        strokeWidth="1.5"
        style={{
          transition: still ? "none" : "all 1100ms cubic-bezier(0.65, 0, 0.35, 1)",
        }}
      />

      {STAGES.map((s, i) => {
        const x = centerOf(i);
        const passed = i < activeIndex;
        return (
          <g key={s.id}>
            {/* What travels to the next stage, written on the segment. */}
            {i < STAGES.length - 1 && (
              <text
                x={x + SPACING / 2}
                y={RAIL_Y - 14}
                textAnchor="middle"
                className={passed ? "fill-signal-300" : "fill-mist-600"}
                fontSize="12"
                fontFamily="var(--font-mono)"
                letterSpacing="0.6"
              >
                {s.handoff}
              </text>
            )}

            {/* The refusal, dropped off the rail rather than given its own beat. */}
            {s.refusal && (
              <g className="opacity-70">
                <path
                  d={`M ${x + NODE_W / 2 - 24} ${RAIL_Y} v 22 q 0 10 10 10 h 26`}
                  fill="none"
                  stroke="currentColor"
                  className="text-halt-400/45"
                  strokeWidth="1.5"
                  strokeDasharray="3 4"
                />
                <text
                  x={x + NODE_W / 2 + 22}
                  y={RAIL_Y + 40}
                  className="fill-halt-400/80"
                  fontSize="11.5"
                  fontFamily="var(--font-mono)"
                  letterSpacing="0.4"
                >
                  {s.refusal}
                </text>
              </g>
            )}

            <rect
              x={x - 5}
              y={RAIL_Y - 5}
              width="10"
              height="10"
              rx="2"
              className={i <= activeIndex ? "fill-signal-400" : "fill-ink-700"}
              stroke={i === activeIndex ? "#a8c5ff" : "none"}
              strokeWidth="1"
            />
          </g>
        );
      })}
    </g>
  );
}

function StageGroup({
  stage,
  index,
  active,
}: {
  stage: Stage;
  index: number;
  active: boolean;
}) {
  const x = centerOf(index);
  const boxX = x - NODE_W / 2;

  return (
    <g
      style={{ transition: "opacity 700ms ease" }}
      className={active ? "opacity-100" : "opacity-35"}
    >
      <rect
        x={boxX}
        y={NODE_Y}
        width={NODE_W}
        height={NODE_H}
        rx="10"
        className={active ? "fill-ink-800" : "fill-ink-900"}
        stroke={active ? "#5b8cff" : "rgba(255,255,255,0.10)"}
        strokeWidth="1.25"
      />
      <circle cx={boxX + 18} cy={NODE_Y + 24} r="3" className="fill-signal-400" />
      <text
        x={boxX + 30}
        y={NODE_Y + 28}
        className="fill-mist-50"
        fontSize="15"
        fontFamily="var(--font-mono)"
        letterSpacing="1.6"
      >
        {stage.label}
      </text>
      <text
        x={boxX + 30}
        y={NODE_Y + 50}
        className="fill-mist-500"
        fontSize="12.5"
        fontFamily="var(--font-mono)"
      >
        {stage.sub}
      </text>

      <ArtifactCard artifact={stage.artifact} x={x - CARD_W / 2} visible={active} />
    </g>
  );
}

/** The payload produced at a stage. Only the one in focus is drawn. */
function ArtifactCard({
  artifact,
  x,
  visible,
}: {
  artifact: Artifact;
  x: number;
  visible: boolean;
}) {
  const accent = artifact.tone === "verified" ? "#5bd6a0" : "#7ea6ff";

  return (
    <g
      style={{ transition: "opacity 600ms ease" }}
      className={visible ? "opacity-100" : "opacity-0"}
    >
      {/* The tether, so the card reads as produced BY the node above it. */}
      <line
        x1={x + CARD_W / 2}
        y1={RAIL_Y + 6}
        x2={x + CARD_W / 2}
        y2={CARD_Y}
        stroke={accent}
        strokeOpacity="0.3"
        strokeWidth="1.25"
        strokeDasharray="2 5"
      />
      <rect
        x={x}
        y={CARD_Y}
        width={CARD_W}
        height={CARD_H}
        rx="10"
        className="fill-ink-900"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1.25"
      />
      <line
        x1={x}
        y1={CARD_Y + 30}
        x2={x + CARD_W}
        y2={CARD_Y + 30}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
      />
      <circle cx={x + 16} cy={CARD_Y + 16} r="3" fill={accent} />
      <text
        x={x + 28}
        y={CARD_Y + 20}
        className="fill-mist-300"
        fontSize="11.5"
        fontFamily="var(--font-mono)"
        letterSpacing="1.4"
      >
        {artifact.title}
      </text>

      {artifact.rows.map(([label, value], i) => {
        const y = CARD_Y + 54 + i * 26;
        const last = i === artifact.rows.length - 1;
        return (
          <g key={label}>
            <text
              x={x + 16}
              y={y}
              className="fill-mist-600"
              fontSize="11.5"
              fontFamily="var(--font-mono)"
            >
              {label}
            </text>
            <text
              x={x + CARD_W - 16}
              y={y}
              textAnchor="end"
              fontSize="11.5"
              fontFamily="var(--font-mono)"
              fill={last ? accent : "#9aa3b5"}
            >
              {value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Where the rail ends.
 *
 * Not a fifth beat — every stage writes evidence as it goes, and this is where
 * the batch of it is published. It sits past the last node so the pipeline
 * visibly terminates in something a third party can read.
 */
function Terminal() {
  return (
    <g className="opacity-45">
      <rect
        x={TERMINAL_X - 96}
        y={RAIL_Y - 26}
        width="192"
        height="52"
        rx="9"
        className="fill-ink-900"
        stroke="rgba(91,214,160,0.28)"
        strokeWidth="1.25"
      />
      <text
        x={TERMINAL_X}
        y={RAIL_Y - 4}
        textAnchor="middle"
        className="fill-verified-400"
        fontSize="12"
        fontFamily="var(--font-mono)"
        letterSpacing="1.4"
      >
        ANCHORED
      </text>
      <text
        x={TERMINAL_X}
        y={RAIL_Y + 15}
        textAnchor="middle"
        className="fill-mist-600"
        fontSize="11"
        fontFamily="var(--font-mono)"
      >
        topic 0.0.10454706
      </text>
    </g>
  );
}

/**
 * Stage buttons and the outcome line.
 *
 * Outside the SVG on purpose: real buttons get focus, keyboard handling and a
 * hit area for free, none of which an SVG shape does without being reinvented.
 */
function Controls({
  active,
  paused,
  onSelect,
  outcome,
}: {
  active: number;
  paused: boolean;
  onSelect: (i: number) => void;
  outcome: string;
}) {
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        {STAGES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(i)}
            aria-current={i === active}
            className={`group relative flex items-center gap-2.5 overflow-hidden rounded-lg border px-3.5 py-2 text-left transition-colors duration-300 ${
              i === active
                ? "border-signal-500/40 bg-signal-500/[0.08]"
                : "border-white/[0.07] hover:border-white/[0.14] hover:bg-white/[0.02]"
            }`}
          >
            <span
              className={`font-mono text-[10px] ${
                i === active ? "text-signal-400" : "text-mist-600"
              }`}
            >
              {s.n}
            </span>
            <span
              className={`text-[13px] ${
                i === active ? "text-mist-50" : "text-mist-500"
              }`}
            >
              {s.label.charAt(0) + s.label.slice(1).toLowerCase()}
            </span>

            {/* The dwell timer, drawn. It doubles as the reason the view moved
                on by itself, which is otherwise unexplained. */}
            {i === active && !paused && (
              <span
                key={`${s.id}-${active}`}
                aria-hidden
                className="absolute bottom-0 left-0 h-px bg-signal-400"
                style={{ animation: `pc-dwell ${DWELL_MS}ms linear forwards` }}
              />
            )}
          </button>
        ))}
      </div>

      <p className="mt-5 flex items-center gap-2.5 text-sm font-medium text-verified-400">
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 8.5 6.2 11.7 13 5" />
        </svg>
        <span key={outcome}>{outcome}</span>
      </p>

      <style>{`@keyframes pc-dwell { from { width: 0 } to { width: 100% } }`}</style>
    </div>
  );
}
