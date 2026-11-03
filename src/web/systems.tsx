"use client";
import { useEffect, useRef, useState } from "react";
import Lenis from "lenis";
import { MQ, ScrollTrigger, gsap, markReady, smooth } from "./gsap";

/* ---------------- smooth scroll (Lenis → ScrollTrigger) ---------------- */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 1, syncTouch: false });
    smooth.lenis = lenis;
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!a || a.getAttribute("href") === "#") return;
      const el = document.querySelector(a.getAttribute("href")!);
      if (el) {
        e.preventDefault();
        lenis.scrollTo(el as HTMLElement, { offset: -80 });
      }
    };
    document.addEventListener("click", click);
    return () => {
      document.removeEventListener("click", click);
      gsap.ticker.remove(tick);
      lenis.destroy();
      smooth.lenis = null;
    };
  }, []);
  return null;
}

/* ---------------- scroll progress bar + nav % ---------------- */
export function ScrollProgress() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const st = ScrollTrigger.create({
      trigger: document.documentElement,
      start: 0,
      end: "max",
      onUpdate: (self) => {
        if (bar.current) bar.current.style.transform = `scaleX(${self.progress})`;
        const l = document.getElementById("scroll-pct");
        if (l) l.textContent = `${Math.round(self.progress * 100)}%`;
      },
    });
    return () => st.kill();
  }, []);
  return <div className="progress" ref={bar} aria-hidden />;
}

/* ---------------- loader ---------------- */
const BOOT = [
  "INITIALIZE RUNTIME",
  "LOAD WORKFLOW MANIFEST",
  "CONNECT SNAPSHOT STORE",
  "VERIFY HASH CHAIN",
  "INDEX STEP OUTPUTS",
  "ARM REPLAY ENGINE",
  "LOAD DIVERGENCE RULES",
  "CHECK SIDE-EFFECT GUARD",
  "RUN DIAGNOSTICS",
  "START SESSION",
];

export function Loader() {
  const [gone, setGone] = useState(false);
  const [pct, setPct] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const html = document.documentElement;
    const skip = sessionStorage.getItem("swytmSeen") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (skip) {
      queueMicrotask(() => setGone(true));
      markReady();
      return;
    }
    html.classList.add("is-loading");
    const state = { p: 0 };
    let ready = false;
    const t0 = performance.now();
    // real readiness: fonts + first API/static data
    Promise.all([
      document.fonts.ready,
      fetch("/api/health", { cache: "no-store" }).catch(() => null),
    ]).then(() => {
      ready = true;
    });
    const up = gsap.to(state, {
      p: 88,
      duration: 1.5,
      ease: "power2.out",
      onUpdate: () => setPct(Math.round(state.p)),
    });
    const poll = window.setInterval(() => {
      if (!ready || performance.now() - t0 < 1600) return;
      window.clearInterval(poll);
      up.kill();
      gsap.to(state, {
        p: 100,
        duration: 0.4,
        ease: "none",
        onUpdate: () => setPct(Math.round(state.p)),
        onComplete: () => {
          gsap
            .timeline({
              onComplete: () => {
                sessionStorage.setItem("swytmSeen", "1");
                html.classList.remove("is-loading");
                setGone(true);
                ScrollTrigger.refresh();
                markReady();
              },
            })
            .to(".loader .pct", { opacity: 0, duration: 0.3 })
            .to(root.current, { yPercent: -100, duration: 0.9, ease: "power3.inOut" });
        },
      });
    }, 60);
    return () => {
      window.clearInterval(poll);
      up.kill();
      html.classList.remove("is-loading");
    };
  }, []);

  if (gone) return null;
  const lit = Math.floor(pct / 10);
  return (
    <div className="loader" ref={root} role="status" aria-live="polite" aria-label={`Loading ${pct}%`}>
      <div className="pct" aria-hidden>
        {pct}%
      </div>
      <ol aria-hidden>
        {BOOT.map((b, i) => (
          <li key={b} className={i < lit || pct >= 100 ? "on" : ""}>
            <span>{String(i + 1).padStart(3, "0")}</span>
            <span>{b}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------- cursor HUD ---------------- */
export function CursorHud() {
  const hud = useRef<HTMLDivElement>(null);
  const cross = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const hx = gsap.quickTo(hud.current, "x", { duration: 0.35, ease: "power3.out" });
    const hy = gsap.quickTo(hud.current, "y", { duration: 0.35, ease: "power3.out" });
    const cx = gsap.quickTo(cross.current, "x", { duration: 0.08 });
    const cy = gsap.quickTo(cross.current, "y", { duration: 0.08 });
    let scrub = { step: 0, t: 0 };
    let over = false;
    let last = { x: 0, y: 0 };
    const paint = () => {
      if (!hud.current) return;
      hud.current.textContent = over
        ? `STEP: ${String(scrub.step + 1).padStart(2, "0")}  T: +${scrub.t.toFixed(2)}s`
        : `X: ${Math.round(last.x)}PX  Y: ${Math.round(last.y)}PX`;
    };
    const move = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      const target = e.target as Element;
      const hidden = !!target.closest?.("[data-hud], .snapcard, .nav, .cookie");
      over = !!target.closest?.("[data-hud]");
      if (hud.current) hud.current.style.opacity = hidden ? "0" : "1";
      hx(e.clientX + 12);
      hy(e.clientY + 12);
      cx(e.clientX);
      cy(e.clientY);
      paint();
    };
    const sc = (e: Event) => {
      scrub = (e as CustomEvent).detail;
      paint();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("swytm:scrub", sc);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("swytm:scrub", sc);
    };
  }, []);
  return (
    <>
      <div className="hud" ref={hud} aria-hidden data-testid="hud">
        X: 0PX Y: 0PX
      </div>
      <div className="cross" ref={cross} aria-hidden />
    </>
  );
}

/* ---------------- cookie bar ---------------- */
export function CookieBar() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setShow(!localStorage.getItem("swytmCookie")));
  }, []);
  if (!show) return null;
  const choose = (v: string) => {
    localStorage.setItem("swytmCookie", v);
    setShow(false);
  };
  return (
    <div className="cookie" role="dialog" aria-label="Cookie preferences">
      <span>This prototype stores only this choice and a session flag in your browser. No tracking is added either way.</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn sm" onClick={() => choose("accept")}>
          Accept
        </button>
        <button className="btn sm ghost" onClick={() => choose("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}

/* ---------------- reveal utilities: data-reveal="lines|words|chars|fade|mask" ---------------- */
export function initReveals(scope: HTMLElement): () => void {
  const mm = gsap.matchMedia();
  mm.add(MQ.motion, () => {
    scope.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
      const kind = el.dataset.reveal;
      let targets: Element[] = [el];
      if (el.dataset.split !== "1" && (kind === "words" || kind === "chars" || kind === "lines" || kind === "mask")) {
        const text = el.textContent ?? "";
        el.setAttribute("aria-label", text);
        el.textContent = "";
        const unit = kind === "chars" ? text.split("") : kind === "words" ? text.split(" ") : [text];
        unit.forEach((u, i) => {
          const m = document.createElement("span");
          m.className = "mask";
          m.setAttribute("aria-hidden", "true");
          if (kind !== "lines" && kind !== "mask") m.style.display = "inline-block";
          const s = document.createElement("span");
          s.textContent = kind === "words" && i < unit.length - 1 ? u + "\u00a0" : u === " " ? "\u00a0" : u;
          s.style.display = "block";
          m.appendChild(s);
          el.appendChild(m);
        });
        el.dataset.split = "1";
      }
      if (kind !== "fade") targets = Array.from(el.querySelectorAll(".mask > span"));
      gsap.set(targets, kind === "fade" ? { opacity: 0, y: 24 } : { yPercent: 110 });
      gsap.to(targets, {
        ...(kind === "fade" ? { opacity: 1, y: 0 } : { yPercent: 0 }),
        duration: 0.9,
        ease: "expo.out",
        stagger: 0.06,
        scrollTrigger: { trigger: el, start: "top 85%", once: true },
        clearProps: "willChange",
      });
    });
    // hairlines draw in
    scope.querySelectorAll<HTMLElement>("[data-hair]").forEach((el) => {
      gsap.fromTo(el, { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 92%", once: true } });
    });
  });
  return () => mm.revert();
}
