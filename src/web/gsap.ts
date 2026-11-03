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

export function scrollToEl(el: Element | number) {
  if (smooth.lenis) smooth.lenis.scrollTo(el as HTMLElement, { offset: -80 });
  else if (typeof el === "number") window.scrollTo({ top: el });
  else el.scrollIntoView({ behavior: "smooth" });
}
