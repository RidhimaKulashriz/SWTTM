"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { diffRuns } from "../core/diff";
import { ClockGlyph, DiffView, Panel, StageArt, TerminalPlayer, TimelineScrubber } from "./components";
import { demo, heroRun, transcriptLines } from "./demo";
import { MQ, ScrollTrigger, gsap, scrollToEl, smooth } from "./gsap";
import { REPO } from "./sections-a";

const steps = heroRun.snapshots;

/* ------------------------------ F. Showcase ------------------------------ */
export function Showcase() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(`${MQ.motion} and ${MQ.desktop}`, () => {
      gsap.set(".sc-chip", { opacity: 0, scale: 0.8 });
      const tl = gsap.timeline({ scrollTrigger: { trigger: root.current, start: "top top", end: "+=250%", pin: true, scrub: true } });
      tl.to(".sc-l1", { y: -120, x: -30, ease: "none" }, 0)
        .to(".sc-l2", { y: -80, ease: "none" }, 0)
        .to(".sc-l3", { y: -40, x: 20, ease: "none" }, 0)
        .to(".sc-l4", { y: 60, ease: "none" }, 0)
        .to(".sc-c1", { opacity: 1, scale: 1, duration: 0.15 }, 0.15)
        .to(".sc-c2", { opacity: 1, scale: 1, duration: 0.15 }, 0.45)
        .to(".sc-c3", { opacity: 1, scale: 1, duration: 0.15 }, 0.75);
    }, root.current!);
    return () => mm.revert();
  }, []);
  const [a, b, c] = steps;
  return (
    <section className="pin" ref={root} aria-label="Showcase">
      <div style={{ position: "absolute", top: 90, left: 0, right: 0, textAlign: "center" }} className="mono label">
        Right there with you · for the whole workflow
      </div>
      <div className="stage" data-hud="showcase">
        <div className="sc-l1" style={{ position: "absolute", left: 0, top: "4%", width: "46%" }}>
          <Panel title={`snapshot 00 · ${a.stepId}`} lines={[`status: ${a.status}`, `input: ${JSON.stringify(a.resolvedInput).slice(0, 30)}…`, `hash: ${a.hash.slice(0, 12)}…`, "prev: null"]} />
        </div>
        <div className="sc-l2" style={{ position: "absolute", left: "26%", top: "22%", width: "46%" }}>
          <Panel title={`snapshot 01 · ${b.stepId}`} lines={[`status: ${b.status}`, `output: ${JSON.stringify(b.output)}`, `hash: ${b.hash.slice(0, 12)}…`, `prev: ${b.prevHash?.slice(0, 8)}…`]} />
        </div>
        <div className="sc-l3" style={{ position: "absolute", right: 0, top: "40%", width: "46%" }}>
          <Panel accent title={`snapshot 02 · ${c.stepId}`} lines={[`status: ${c.status}`, `error: ${c.error?.category}`, `hash: ${c.hash.slice(0, 12)}…`, `prev: ${c.prevHash?.slice(0, 8)}…`]} />
        </div>
        <div className="sc-l4" style={{ position: "absolute", left: "8%", bottom: "-4%", width: "40%" }}>
          <Panel w={300} h={150} title="replay · from step 2" lines={["0 create → injected", "1 label  → injected", "2 close  → executed"]} />
        </div>
        <span className="chip sc-chip sc-c1" style={{ left: "52%", top: "6%" }}>Snapshot 02 · hash {b.hash.slice(0, 4)}…</span>
        <span className="chip red sc-chip sc-c2" style={{ left: "6%", top: "58%" }}>Injected, not re-run</span>
        <span className="chip sc-chip sc-c3" style={{ right: "4%", bottom: "6%" }}>Side effect: 1 created (tail replay)</span>
      </div>
    </section>
  );
}

/* ------------------------------ G. Introduction ------------------------------ */
const INTRO = [
  "Agent workflows rarely fail at the start.",
  "They fail in the middle, after real things already happened.",
  "Time Machine snapshots every step, so you can go back.",
  "Change one input. Replay the tail. See exactly what changed.",
];
export function Intro() {
  const root = useRef<HTMLElement>(null);
  const [sel, setSel] = useState(1);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(`${MQ.motion} and ${MQ.desktop}`, () => {
      const ps = gsap.utils.toArray<HTMLElement>(".intro-stack p");
      gsap.set(ps, { opacity: 0 });
      const tl = gsap.timeline({ scrollTrigger: { trigger: root.current, start: "top top", end: "+=400%", pin: true, scrub: true } });
      ps.forEach((p, i) => {
        tl.fromTo(p, { opacity: 0, y: 24, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1, ease: "none" });
        if (i < ps.length - 1) tl.to(p, { opacity: 0, y: -24, filter: "blur(8px)", duration: 1, ease: "none" }, "+=0.8");
      });
    }, root.current!);
    return () => mm.revert();
  }, []);
  return (
    <section className="pin" ref={root} id="intro" aria-label="Introduction">
      <div style={{ position: "absolute", top: 90, left: "var(--gutter)" }} className="label">Introduction</div>
      <div className="intro-stack wrap" data-testid="intro">
        {INTRO.map((t) => (
          <p key={t} className="display">{t}</p>
        ))}
      </div>
      <div className="mini">
        <span className="label caret">[ Click on a step ]</span>
        {steps.filter((s) => !s.stepId.includes(":")).map((s, i) => (
          <button key={s.stepId} aria-pressed={sel === i} onClick={() => setSel(i)}>
            0{i + 1} {s.stepId} · {sel === i ? `#${s.hash.slice(0, 8)}` : s.status}
          </button>
        ))}
      </div>
      <div className="mono label caret" style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)" }}>[ Scroll to continue ]</div>
    </section>
  );
}

/* ------------------------------ H. Solution ------------------------------ */
export function Solution() {
  const [v, setV] = useState(2);
  const d = useMemo(
    () => diffRuns({ runId: demo.runs[0].manifest.runId, steps: demo.runs[0].snapshots }, { runId: demo.runs[1].manifest.runId, steps: demo.runs[1].snapshots }),
    [],
  );
  const miniSteps = steps.map((s) => ({ id: s.stepId, status: s.status }));
  return (
    <section className="section light" id="solution">
      <div className="wrap">
        <div className="label">Solution</div>
        <h2 className="display h2" style={{ margin: "16px 0 40px", maxWidth: "16ch" }} data-reveal="mask">Run it natively in your workflow</h2>
        <div className="row2">
          <div>
            <div className="mono" style={{ marginBottom: 12 }}>[01] CLI</div>
            <p className="lead" style={{ margin: "0 0 20px" }}>
              Run a workflow, inspect any step, replay from step N with one changed input. Earlier steps are injected from their recorded outputs — the executor is never called for them.
            </p>
            <Link className="link" href="/app">Learn more</Link>
          </div>
          <TerminalPlayer lines={transcriptLines} title="swy-tm demo · recorded real run · live GitHub" />
        </div>
        <div className="row2 flip">
          <div>
            <div className="mono" style={{ marginBottom: 12 }}>[02] DEBUGGER</div>
            <p className="lead" style={{ margin: "0 0 20px" }}>
              A local, keyboard-first console over the same snapshots: timeline, inspector, replay panel and divergence drawer.
            </p>
            <Link className="link" href="/app">Learn more</Link>
          </div>
          <div className="frame" style={{ padding: 16 }}>
            <div className="label">Live miniature · recorded from a real GitHub run</div>
            <TimelineScrubber steps={miniSteps} value={v} onChange={setV} onCommit={(i) => setV(i)} />
            <DiffView diff={d} />
          </div>
        </div>
        <ul style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16, padding: 0, listStyle: "none", borderTop: "1px solid var(--line-dark)", paddingTop: 24 }}>
          {["Understands every step's input and output.", "Guards steps with real side effects.", "Replays from any step after your approval flag."].map((b, i) => (
            <li key={b} style={{ display: "flex", gap: 12 }}>
              <span className="mono">[0{i + 1}]</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------ I. Why us ------------------------------ */
const WHY = [
  { k: "SNAPSHOT", t: "Every step is recorded with a hash", chip: "sha256 chain" },
  { k: "INSPECT", t: "See the exact input and output at any step", chip: "resolvedInput · output" },
  { k: "REPLAY", t: "Re-run only the tail, with your change", chip: "executor calls: 1" },
  { k: "DIVERGE", t: "Diff the new run against the old one", chip: "error → ok" },
];
export function WhyUs() {
  const root = useRef<HTMLElement>(null);
  const [stage, setStage] = useState(0);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(`${MQ.motion} and ${MQ.desktop}`);
    const f = () => setPinned(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  useEffect(() => {
    if (!pinned) return;
    const rootEl = root.current;
    const st = ScrollTrigger.create({
      trigger: rootEl,
      start: "top top",
      end: "+=400%",
      pin: true,
      onUpdate: (self) => setStage(Math.min(3, Math.floor(self.progress * 4))),
      onEnter: () => gsap.set(rootEl, { autoAlpha: 1, pointerEvents: "auto" }),
      onEnterBack: () => gsap.set(rootEl, { autoAlpha: 1, pointerEvents: "auto" }),
      onLeaveBack: () => gsap.set(rootEl, { autoAlpha: 1, pointerEvents: "auto" }),
      onLeave: () => gsap.set(rootEl, { autoAlpha: 0, pointerEvents: "none" }),
    });
    return () => {
      st.kill();
      gsap.set(rootEl, { autoAlpha: 1 });
      setStage(0);
    };
  }, [pinned]);
  useEffect(() => {
    if (!pinned) return;
    gsap.fromTo(".why-art", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out", clearProps: "opacity,transform" });
    gsap.fromTo(".why-title > span", { yPercent: 110 }, { yPercent: 0, duration: 0.7, ease: "expo.out", clearProps: "transform" });
  }, [stage, pinned]);
  const items = pinned ? [WHY[stage]] : WHY;
  return (
    <section className="pin" id="why" ref={root} aria-label="Why Time Machine" data-stage={stage}>
      <div className="wrap why" style={{ alignItems: pinned ? "center" : "start" }}>
        <div>
          <div className="label">Why us</div>
          <h2 className="display h2" style={{ margin: "16px 0 20px" }}>Built to work the way you do</h2>
          <p className="lead">Four moves, in order. You decide when to rewind and what to change; Time Machine keeps the rest exactly as it was.</p>
          {pinned && (
            <div className="dots" aria-hidden>
              {WHY.map((w, i) => (
                <i key={w.k} className={i <= stage ? "on" : ""} />
              ))}
            </div>
          )}
        </div>
        <div>
          {items.map((w) => {
            const i = WHY.indexOf(w);
            return (
              <div key={w.k} style={{ marginBottom: pinned ? 0 : 48, position: "relative" }}>
                <div className="why-art" style={{ position: "relative" }}>
                  <StageArt stage={i} />
                  <span className="chip red" style={{ position: "absolute", right: 12, top: 12 }}>{w.chip}</span>
                </div>
                <div className="mono label" style={{ marginTop: 16 }}>0{i + 1} / 04 · {w.k}</div>
                <h3 className="display why-title" style={{ fontSize: "clamp(26px,3vw,48px)", margin: "6px 0 0" }}>
                  <span className="mask"><span>{w.t}</span></span>
                </h3>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ J. Use cases ------------------------------ */
const CASES = [
  ["Agent builders", "Debug a multi-step agent run without re-triggering the steps that worked."],
  ["Platform engineers", "Keep a verifiable record of what each step did and what it left behind."],
  ["QA for workflows", "Replay the same tail with different inputs and diff the outcomes."],
  ["Integration developers", "See the exact resolved input your Wrekenfile method received."],
  ["Solo founders", "Fix a one-field mistake without paying for the whole run again."],
  ["Hackathon teams", "Demo a failure and a recovery in under a minute, offline."],
  ["Support engineers", "Reconstruct what happened in a customer's failed run from its snapshots."],
  ["Students learning APIs", "Step through a workflow and watch inputs flow into outputs."],
];
export function UseCases() {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(`${MQ.motion} and ${MQ.desktop}`, () => {
      const dist = () => Math.max(0, track.current!.scrollWidth - window.innerWidth);
      gsap.to(track.current, { x: () => -dist(), ease: "none", scrollTrigger: { trigger: root.current, start: "top top", end: () => `+=${dist()}`, pin: true, scrub: 1, invalidateOnRefresh: true } });
    }, root.current!);
    return () => mm.revert();
  }, []);
  return (
    <section className="pin" ref={root} id="use-cases" style={{ alignContent: "center", display: "block" }}>
      <div style={{ paddingTop: "clamp(72px,10vh,140px)" }}>
        <div className="wrap" style={{ marginBottom: 32 }}>
          <div className="label">Use cases</div>
          <h2 className="display h2" style={{ marginTop: 12 }}>Made for people who ship agents</h2>
        </div>
        <div className="hscroll" ref={track} data-testid="hscroll" tabIndex={0} aria-label="Use cases">
          {CASES.map(([t, d], i) => (
            <article className="ucard" key={t}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="mono">0{i + 1}</span>
                <svg width="64" height="40" viewBox="0 0 64 40" fill="none" stroke="currentColor" aria-hidden>
                  <path d={["M2 20H62", "M2 30C20 30 20 10 40 10H62", "M2 8H30V32H62", "M2 20H20L30 8L40 32L50 20H62"][i % 4]} />
                  <circle cx="2" cy="20" r="3" />
                </svg>
              </div>
              <div>
                <h3 className="display" style={{ fontSize: "clamp(28px,3vw,52px)", margin: "0 0 10px" }}>{t}</h3>
                <p className="lead" style={{ margin: 0 }}>{d}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ K. CTA ------------------------------ */
export function Cta() {
  const root = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(MQ.motion, () => {
      gsap.fromTo(".cta-art", { rotate: 0 }, { rotate: 40, ease: "none", scrollTrigger: { trigger: root.current, start: "top bottom", end: "bottom top", scrub: true } });
    }, root.current!);
    return () => mm.revert();
  }, []);
  const cmd = "npm i && npx tsx src/cli/index.ts demo";
  return (
    <section className="section" id="cta" ref={root} style={{ overflow: "hidden", borderTop: "1px solid var(--line)" }}>
      <svg className="cta-art" viewBox="0 0 400 400" aria-hidden style={{ position: "absolute", right: "-8%", top: "50%", marginTop: "-30vw", width: "60vw", opacity: 0.14 }} fill="none" stroke="#f3f2ee">
        <circle cx="200" cy="200" r="190" strokeDasharray="3 7" />
        <circle cx="200" cy="200" r="120" />
        <path d="M200 200V70M200 200L290 250M290 250H380M290 250V340" strokeWidth="2" />
      </svg>
      <div className="wrap" style={{ position: "relative" }}>
        <h2 className="display h2" style={{ maxWidth: "16ch" }} data-reveal="mask">See what Time Machine can do in your workflow</h2>
        <p className="lead" style={{ margin: "24px 0" }}>Clone the repo and run the demo in under a minute.</p>
        <div className="codechip" style={{ marginBottom: 28 }}>
          <code>{cmd}</code>
          <button className="chipf" onClick={async () => { await navigator.clipboard?.writeText(cmd).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link className="btn" href="/app">Open debugger</Link>
          <a className="btn ghost" href={REPO} target="_blank" rel="noreferrer">View on GitHub</a>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ L. Footer ------------------------------ */
export function Footer() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add(MQ.motion, () => {
      gsap.from(".giant", { yPercent: 40, opacity: 0, ease: "none", scrollTrigger: { trigger: root.current, start: "top 90%", end: "bottom bottom", scrub: true } });
    }, root.current!);
    return () => mm.revert();
  }, []);
  const col = (h: string, items: [string, string][]) => (
    <div>
      <h4 className="label">{h}</h4>
      <ul>
        {items.map(([t, href]) => (
          <li key={t}><a href={href}>{t}</a></li>
        ))}
      </ul>
    </div>
  );
  return (
    <footer className="footer" ref={root}>
      <div className="wrap">
        <div className="cols">
          {col("Company", [["About", "#statement"], ["Problems", "#problems"], ["Use cases", "#use-cases"]])}
          {col("Product", [["Snapshots", "#why"], ["Replay engine", "#solution"], ["Debugger", "/app"]])}
          {col("Resources", [["Swytchcode docs", "https://docs.swytchcode.com"], ["Source", REPO]])}
          <div>
            <h4 className="label">Contact</h4>
            <p style={{ margin: "0 0 12px" }}>No email collection here by design.</p>
            <a className="btn sm ghost" href={REPO} target="_blank" rel="noreferrer">★ Star on GitHub</a>
          </div>
        </div>
        <div className="giant" aria-hidden>SWY-TM</div>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginTop: 24 }} className="label">
          <span>©2026 swy-tm — independent prototype, MIT. Not affiliated with Swytchcode.</span>
          <span>Interaction design inspired by modern award-style agency sites.</span>
          <button className="chipf" onClick={() => (smooth.lenis ? smooth.lenis.scrollTo(0) : scrollToEl(0))}>↑ Back to top</button>
        </div>
      </div>
    </footer>
  );
}

export { ClockGlyph };
