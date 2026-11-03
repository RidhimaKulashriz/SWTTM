"use client";
import { useEffect, useRef } from "react";
import { CookieBar, CursorHud, Loader, ScrollProgress, SmoothScroll, initReveals } from "./systems";
import { Hero, Marquee, Nav, Problems, Statement } from "./sections-a";
import { Cta, Footer, Intro, Showcase, Solution, UseCases, WhyUs } from "./sections-b";
import { ScrollTrigger, onReady } from "./gsap";

export default function Landing() {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const off = initReveals(main.current!);
    const refresh = () => ScrollTrigger.refresh();
    document.fonts.ready.then(refresh);
    const off2 = onReady(refresh);
    return () => {
      off();
      off2();
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
