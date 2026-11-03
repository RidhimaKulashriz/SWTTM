"use client";
import { useEffect, useRef } from "react";
import { CookieBar, CursorHud, Loader, ScrollProgress, SmoothScroll, initReveals } from "./systems";
import { Hero, Marquee, Nav, Problems, Statement } from "./sections-a";
import { Cta, Footer, Intro, Showcase, Solution, UseCases, WhyUs } from "./sections-b";
import { ScrollTrigger, onReady, restoreScrollPosition, trackScrollPosition } from "./gsap";

export default function Landing() {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const off = initReveals(main.current!);
    const refresh = () => ScrollTrigger.refresh();
    document.fonts.ready.then(refresh);
    const stopTracking = trackScrollPosition();
    let stopRestore = () => {};
    // restore the reading position only once pins have been measured, otherwise it lands in the wrong section
    const off2 = onReady(() => {
      ScrollTrigger.refresh();
      stopRestore = restoreScrollPosition();
      document.fonts.ready.then(refresh);
    });
    return () => {
      off();
      off2();
      stopRestore();
      stopTracking();
    };
  }, []);
  return (
    <>
      <SmoothScroll />
      <Loader />
      <ScrollProgress />
      <CursorHud />
      <Nav />
      <main ref={main}>
        <Hero />
        <Statement />
        <Marquee />
        <Problems />
        <Showcase />
        <Intro />
        <Solution />
        <WhyUs />
        <UseCases />
        <Cta />
      </main>
      <Footer />
      <CookieBar />
    </>
  );
}
