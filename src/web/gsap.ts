"use client";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type Lenis from "lenis";

if (typeof window !== "undefined") gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

export const smooth: { lenis: Lenis | null } = { lenis: null };

export const MQ = {
  motion: "(prefers-reduced-motion: no-preference)",
  desktop: "(min-width: 811px)",
  mobile: "(max-width: 810px)",
};

type W = Window & { __swytmReady?: boolean };

export function markReady() {
  (window as W).__swytmReady = true;
  window.dispatchEvent(new Event("swytm:ready"));
}

/** run cb once the loader has finished (or immediately if it already did / was skipped) */
export function onReady(cb: () => void): () => void {
  if ((window as W).__swytmReady) {
    cb();
    return () => {};
  }
  const h = () => cb();
  window.addEventListener("swytm:ready", h, { once: true });
  return () => window.removeEventListener("swytm:ready", h);
}

/**
 * Document position an element should be scrolled to. A pinned section is measured from its ScrollTrigger start
 * (its live bounding box is meaningless while it is fixed), everything else from its real box.
 */
export function scrollTargetY(el: HTMLElement, offset = 0): number {
  const pin = ScrollTrigger.getAll().find((t) => t.trigger === el && t.pin);
  if (pin) return Math.max(0, Math.round(pin.start));
  return Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY + offset));
}

export function scrollToEl(el: Element | number) {
  const y = typeof el === "number" ? el : scrollTargetY(el as HTMLElement, -80);
  if (smooth.lenis) smooth.lenis.scrollTo(y);
  else window.scrollTo({ top: y, behavior: "smooth" });
}

/* ---- keep the reading position across reload / back-navigation (pinned layouts break native restoration) ---- */
const POS_KEY = "swytmScrollY";
let restoring = false;

export function trackScrollPosition(): () => void {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const save = () => {
    if (restoring) return; // never overwrite the saved spot with the temporary top-of-page position
    try {
      sessionStorage.setItem(POS_KEY, String(Math.round(window.scrollY)));
    } catch {
      /* storage unavailable */
    }
  };
  window.addEventListener("pagehide", save);
  const vis = () => document.visibilityState === "hidden" && save();
  document.addEventListener("visibilitychange", vis);
  return () => {
    save();
    window.removeEventListener("pagehide", save);
    document.removeEventListener("visibilitychange", vis);
  };
}

/**
 * Put the reader back where they were. Pin spacers are added asynchronously (fonts, matchMedia, refresh), so keep
 * trying until the page is tall enough to reach the saved position, and give up the moment the user scrolls.
 */
export function restoreScrollPosition(): () => void {
  if (location.hash) return () => {};
  let y = 0;
  try {
    y = Number(sessionStorage.getItem(POS_KEY) ?? 0) || 0;
  } catch {
    /* storage unavailable */
  }
  if (y <= 0) return () => {};
  restoring = true;
  let stop = () => {};
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    restoring = false;
    window.clearInterval(timer);
    window.clearTimeout(giveUp);
    ["wheel", "touchstart", "keydown", "pointerdown"].forEach((t) => window.removeEventListener(t, finish));
  };
  stop = finish;
  const jump = (to: number) => {
    if (smooth.lenis) smooth.lenis.scrollTo(to, { immediate: true, force: true });
    window.scrollTo(0, to);
    ScrollTrigger.update();
  };
  let settled = 0;
  const timer = window.setInterval(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max < y - 2) return; // pins not measured yet
    if (Math.abs(window.scrollY - y) > 2) {
      settled = 0;
      jump(y);
    } else if (++settled >= 4) {
      finish(); // stayed put for ~200ms after the layout finished changing
    }
  }, 50);
  const giveUp = window.setTimeout(finish, 4000);
  ["wheel", "touchstart", "keydown", "pointerdown"].forEach((t) => window.addEventListener(t, finish, { passive: true, once: true }));
  return stop;
}
