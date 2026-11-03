"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClockGlyph } from "./components";
import { heroRun } from "./demo";
import { MQ, ScrollTrigger, gsap, onReady, scrollToEl } from "./gsap";

export const REPO = process.env.NEXT_PUBLIC_REPO_URL || "https://github.com";

/* ------------------------------ A. Nav ------------------------------ */
export function Nav() {
  const [hide, setHide] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const st = ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate: (self) => setHide(self.direction === 1 && self.scroll() > 120),
    });
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setMenu(false);
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    };
    window.addEventListener("keydown", esc);
    return () => {
      st.kill();
      window.removeEventListener("keydown", esc);
    };
  }, []);
  const links = (
    <>
      <li className={`dd ${open ? "open" : ""}`}>
        <button className="mono" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Product ▾
        </button>
        <div className="menu mono">
          <a href="#why">Snapshots</a>
          <a href="#solution">Replay Engine</a>
          <Link href="/app">Debugger</Link>
        </div>
      </li>
      <li><a className="mono" href="https://docs.swytchcode.com" target="_blank" rel="noreferrer">Docs</a></li>
      <li><a className="mono" href="#statement">About</a></li>
      <li><a className="mono" href={REPO} target="_blank" rel="noreferrer">GitHub</a></li>
    </>
  );
  return (
    <>
      <header className={`nav ${hide && !menu ? "hide" : ""}`}>
        <Link href="/" className="brand" aria-label="swy-tm home">
          <ClockGlyph /> swy-tm
        </Link>
        <nav aria-label="Primary">
          <ul>{links}</ul>
        </nav>
        <div className="right">
          <span className="mono label" aria-hidden id="scroll-pct">0%</span>
          <Link className="btn sm" href="/app">Open debugger</Link>
          <button className="burger mono" aria-expanded={menu} aria-controls="mnav" onClick={() => setMenu((m) => !m)}>
            {menu ? "Close" : "Menu"}
          </button>
        </div>
      </header>
      {menu && (
        <div className="mnav" id="mnav" onClick={() => setMenu(false)}>
          {["#why:Snapshots", "#solution:Replay Engine", "/app:Debugger", "#statement:About"].map((x) => {
            const [h, t] = x.split(":");
            return (
              <a key={h} href={h} className="display" style={{ fontSize: 48 }}>
                {t}
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ------------------------------ B. Hero ------------------------------ */
export function Hero() {
  const root = useRef<HTMLElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const steps = useMemo(() => heroRun.snapshots.filter((s) => !s.stepId.endsWith(":compensate")), []);
  const n = steps.length;
  const [pos, setPos] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const dragging = useRef(false);
  const posRef = useRef(0);
  const tween = useRef<gsap.core.Tween | null>(null);
  const W = narrow ? 790 : 1600;
  const H = 400;
  const x0 = narrow ? 125 : 320;
  const gap = narrow ? 270 : 480;
  const nodeX = (i: number) => x0 + i * gap;
  const active = Math.round(pos);
  const failed = steps.findIndex((s) => s.status === "error");
  const t0 = new Date(steps[0].startedAt).getTime();

  useEffect(() => {
    const mq = window.matchMedia(MQ.mobile);
    const f = () => setNarrow(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);

  const set = (v: number) => {
    posRef.current = v;
    setPos(v);
    const i = Math.round(v);
    window.dispatchEvent(new CustomEvent("swytm:scrub", { detail: { step: i, t: (new Date(steps[i].startedAt).getTime() - t0) / 1000 } }));
  };
  const toX = (e: React.PointerEvent) => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse());
    return Math.min(n - 1, Math.max(0, (p.x - x0) / gap));
  };
  const snap = (to: number) => {
    const o = { v: posRef.current };
    tween.current?.kill();
    tween.current = gsap.to(o, { v: to, duration: 0.6, ease: "back.out(1.6)", onUpdate: () => set(Math.min(n - 1, Math.max(0, o.v))) });
  };

  // intro + pin
  useEffect(() => {
    const off = onReady(() => {
      const mm = gsap.matchMedia();
      mm.add(MQ.motion, () => {
        const tl = gsap.timeline();
        tl.from(".hero .conn", { strokeDashoffset: 1, duration: 1.4, ease: "power2.inOut", stagger: 0.25 }, 0)
          .from(".hero .node", { opacity: 0, y: 16, duration: 0.8, stagger: 0.15, ease: "expo.out" }, 0.2)
          .from(".hero .hl > span", { yPercent: 110, duration: 1, stagger: 0.1, ease: "expo.out" }, 0.1)
          .from(".hero .fadein", { opacity: 0, y: 16, duration: 0.8, stagger: 0.08, ease: "expo.out" }, 0.6);
      });
      mm.add(`${MQ.motion} and ${MQ.desktop}`, () => {
        const st = ScrollTrigger.create({ trigger: root.current, start: "top top", end: "+=120%", pin: true, pinSpacing: true });
        return () => st.kill();
      });
    });
    return off;
  }, []);

  const err = steps[failed >= 0 ? failed : 0];
  const raw = (err.error?.raw ?? {}) as { status?: number };
  const callout = failed >= 0 ? `STEP ${String(failed + 1).padStart(2, "0")} · ${raw.status ?? "ERR"} · ${err.error?.message.split(":")[0]}` : "";
  const cur = steps[active];
  const cy = 240;
  const CW = narrow ? 440 : 380;

  return (
    <section className="hero" ref={root} id="top" aria-label="Hero">
      <div className="meta mono label fadein" aria-hidden>
        TYPE : Developer tool<br />
        BUILT FOR : Swytchcode<br />
        STATUS : Prototype<br />
        LICENSE : MIT
      </div>

      <div className="copy">
        <h1 className="display h1">
          {["A TIME MACHINE", "FOR AGENT", "WORKFLOWS"].map((l) => (
            <span key={l} className="mask hl"><span>{l}</span></span>
          ))}
        </h1>
        <p className="lead fadein" style={{ margin: "24px 0", color: "var(--paper)" }}>
          Rewind a failed run, change one input, replay only the tail. Steps that already happened are never repeated.
        </p>
        <div className="fadein" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <a className="btn" href="#statement">Discover more ↓</a>
          <a className="btn ghost" href="#solution">Run the demo</a>
        </div>
      </div>

      <div
        className="canvas"
        data-hud="hero"
        data-testid="hero-canvas"
        role="slider"
        tabIndex={0}
        aria-label="Workflow timeline. Drag or use arrow keys to scrub."
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={active}
        aria-valuetext={`Step ${active + 1} of ${n}: ${cur.stepId}, ${cur.status}`}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          tween.current?.kill();
          set(toX(e));
        }}
        onPointerMove={(e) => dragging.current && set(toX(e))}
        onPointerUp={() => {
          dragging.current = false;
          snap(Math.round(posRef.current));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          snap(Math.round(posRef.current));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") snap(Math.min(n - 1, Math.round(posRef.current) + 1));
          if (e.key === "ArrowLeft") snap(Math.max(0, Math.round(posRef.current) - 1));
        }}
      >
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
          {steps.slice(1).map((_, i) => (
            <path key={i} className="conn" pathLength={1} strokeDasharray={1} d={`M${nodeX(i) + 110} ${cy} H${nodeX(i + 1) - 110}`} stroke={i + 1 === failed ? "#ff2a1a" : "rgba(243,242,238,.55)"} fill="none" strokeWidth="1.5" />
          ))}
          {steps.map((s, i) => {
            const bad = s.status === "error";
            const filled = pos >= i - 0.02;
            return (
              <g key={s.stepId} className="node">
                <rect x={nodeX(i) - 110} y={cy - 60} width="220" height="120" rx="14" fill={filled ? (bad ? "#ff2a1a" : "#f3f2ee") : "transparent"} stroke={bad ? "#ff2a1a" : "rgba(243,242,238,.7)"} strokeWidth="1.5" style={{ transition: "fill .25s" }} />
                <text x={nodeX(i) - 90} y={cy - 18} fontFamily="var(--font-mono)" fontSize={narrow ? 26 : 18} letterSpacing="2" fill={filled && !bad ? "#0a0a0a" : "#f3f2ee"}>
                  {String(i + 1).padStart(2, "0")} {s.stepId.toUpperCase()}
                </text>
                <text x={nodeX(i) - 90} y={cy + 24} fontFamily="var(--font-mono)" fontSize={narrow ? 15 : 14} fill={filled && !bad ? "#0a0a0a" : "rgba(243,242,238,.65)"}>
                  {s.canonicalId}
                </text>
              </g>
            );
          })}
          {failed >= 0 && (
            <g className="node">
              <path d={`M${nodeX(failed)} ${cy - 60} V${cy - 150} H${nodeX(failed) - 60}`} stroke="#ff2a1a" fill="none" />
              <rect x={nodeX(failed) - 60 - CW} y={cy - 172} width={CW} height="44" fill="#ff2a1a" />
              <text x={nodeX(failed) - 60 - CW + 16} y={cy - 143} fontFamily="var(--font-mono)" fontSize={narrow ? 20 : 15} letterSpacing="1" fill="#0a0a0a">
                {callout}
              </text>
            </g>
          )}
          <g style={{ transform: `translateX(${x0 + pos * gap}px)` }}>
            <path d={`M0 ${cy - 224} V${cy + 130}`} stroke="#3dff9a" strokeWidth="1.5" />
            <path d={`M-10 ${cy - 224} h20 l-10 14z`} fill="#3dff9a" />
          </g>
        </svg>
      </div>

      <div className="snapcard mono" aria-live="polite">
        <div className="label">snapshot · step {active + 1} · {cur.status}</div>
        <pre>
          {`input   ${JSON.stringify(cur.resolvedInput)}\n${cur.status === "error" ? `error   ${cur.error?.message}` : `output  ${JSON.stringify(cur.output)}`}\nhash    ${cur.hash.slice(0, 8)}…`}
        </pre>
        <div className="label" style={{ marginTop: 8 }}>real data · MOCK executor</div>
      </div>

      <div className="herofoot">
      <div className="tags mono label fadein">
        {["Faster recovery", "No duplicate effects", "Verified snapshots"].map((t) => (
          <span key={t} className="tag">{t}</span>
        ))}
      </div>
      <div className="hint mono label caret">Drag to scrub the timeline</div>
      </div>
    </section>
  );
}

/* ------------------------------ C. Statement ------------------------------ */
const STATEMENT =
  "The repetitive part of debugging an agent is re-running what already worked. Time Machine remembers it for you so you can spend your time on what failed.";

export function Statement() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(MQ.motion, () => {
      const words = root.current!.querySelectorAll(".word");
      gsap.to(words, { opacity: 1, ease: "none", stagger: 0.1, scrollTrigger: { trigger: root.current, start: "top 75%", end: "bottom 45%", scrub: true } });
    });
    return () => mm.revert();
  }, []);
  return (
    <section className="section wrap" id="statement" ref={root}>
      <div className="label" style={{ marginBottom: 24 }}>[ About ]</div>
      <p className="display statement" data-testid="statement">
        <span className="sr">{STATEMENT}</span>
        {STATEMENT.split(" ").map((w, i) => (
          <span key={i} className="word" aria-hidden>
            {w}&nbsp;
          </span>
        ))}
      </p>
      <p style={{ marginTop: 40 }}>
        <a className="link" href="#problems">Learn more</a>
      </p>
    </section>
  );
}

/* ------------------------------ D. Marquee ------------------------------ */
const STACK = ["swytchcode CLI", "Wrekenfile", "GitHub", "Stripe", "Node.js", "MCP", "Vitest", "Playwright"];
export function Marquee() {
  const row = STACK.map((s) => <span key={s}>{s}</span>);
  return (
    <section aria-label="Works with">
      <div className="wrap" style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", padding: "24px var(--gutter)" }}>
        <span className="label">Works with the tools you already use</span>
        <span className="label">Wraps swytchcode exec. Reads no private state.</span>
      </div>
      <div className="marquee" aria-hidden>
        <div className="track">
          <div style={{ display: "flex" }}>{row}</div>
          <div style={{ display: "flex" }}>{row}</div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ E. Problems ------------------------------ */
const PROBLEMS = [
  { t: "MANUAL", h: "Recovery is a re-run", b: "You restart from step 1 and hope everything is idempotent." },
  { t: "DISJOINTED", h: "The log and the state live apart", b: "You read the log and guess what step 2 left behind." },
  { t: "BLIND", h: "Failures hide in the middle", b: "Nothing lets you inspect the exact input that broke step 3." },
  { t: "SLOW", h: "One typo costs a full run", b: "The whole workflow pays for a one-field fix." },
];
export function Problems() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(MQ.motion, () => {
      gsap.from(".pcard", { opacity: 0, y: 48, duration: 1, stagger: 0.12, ease: "expo.out", scrollTrigger: { trigger: ".cards4", start: "top 80%", once: true }, clearProps: "all" });
    }, root.current!);
    return () => mm.revert();
  }, []);
  return (
    <section className="section light" id="problems" ref={root}>
      <div className="wrap">
        <div className="label">Problems</div>
        <h2 className="display h2" style={{ margin: "16px 0 56px", maxWidth: "18ch" }} data-reveal="mask">
          Audit logs tell you what happened. They can&apos;t undo it.
        </h2>
        <div className="hair" data-hair />
        <div className="cards4">
          {PROBLEMS.map((p, i) => (
            <article className="pcard" key={p.t}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="mono ctr">[{String(i + 1).padStart(2, "0")}]</span>
                <span className="mono label">{p.t}</span>
              </div>
              <div>
                <h3 className="display">{p.h}</h3>
                <p style={{ margin: 0 }}>{p.b}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export { scrollToEl };
