# UI parity report

**Honest status:** the reference site (heronaiapp.com) was **not studied with REA, not fetched, and not measured** (see FRICTION.md, last row). The UI was built from the section map, motion description and fallback design tokens in the build spec only. No reference CSS/JS/images/copy were used; all copy and SVG art are original. "Match" below therefore means "matches the spec's description of the pattern", not "verified against the live site". Design tokens are the spec's fallbacks (not measured values).

| Reference behavior (per spec) | Implementation | Status |
|---|---|---|
| Loader with percentage + 10 boot lines | `src/web/systems.tsx` `Loader` — real readiness (fonts + `/api/health`), min 1.6 s, slide-up exit, skipped via `sessionStorage.swytmSeen` / reduced motion | match (e2e: loader removed, second visit skips) |
| Coordinate HUD + crosshair | `CursorHud` — `X/Y` readout, `STEP/T` over hero canvas, `gsap.quickTo(.35)`, hidden on coarse pointers | match (e2e on desktop) |
| Draggable hero timeline with callouts | `sections-a.tsx` `Hero` — SVG generated from `examples/snapshots/demo.json`, pointer drag, spring snap, arrow keys, `role=slider` | match (e2e: drag, snap to integer, arrows) |
| Scrubbed statement band | `Statement` — word opacity .15→1 via ScrollTrigger scrub | match (e2e: opacity sum increases) |
| Logo marquee | `Marquee` — text wordmarks, 40 s linear, pause on hover, duplicated track | match |
| 4 problem cards | `Problems` — `[01]–[04]`, tags, 4/2/1 columns, stagger .12, hover lift + red counter | match |
| Parallax showcase with callouts | `Showcase` — pinned 250%, 4 SVG panels at different speeds, 3 chips in sequence | adapted (desktop only; stacked on mobile) |
| Pinned intro, "scroll to continue" | `Intro` — pinned 400%, 4 statements cross-fade/blur, mini timeline | adapted (stacked on mobile / reduced motion) |
| Solution rows | `Solution` — terminal player replaying `examples/transcripts/demo.json` (captured from a real MOCK demo run); live miniature reusing `TimelineScrubber` + `DiffView` | match |
| 4-stage why-us | `WhyUs` — pinned 400%, stage index from ScrollTrigger progress, 4 SVGs, dot indicator | match (e2e: stage 0→3 monotonic). Mobile/reduced motion: all 4 stages stacked |
| Horizontal use-cases | `UseCases` — pinned, vertical→horizontal scrub; `overflow-x` + scroll-snap on mobile | match (e2e: translateX decreases) |
| CTA with rotating art | `Cta` — scroll-linked 0→40° rotation, copyable command | match |
| Giant footer wordmark | `Footer` — outline `SWY-TM` in `vw`, rises on scroll, GitHub-star link instead of email field | match |
| Nav hide/show, dropdown, progress %, cookie bar | `Nav`, `ScrollProgress`, `CookieBar` | match |
| Lenis + ScrollTrigger, reduced-motion fallback | `SmoothScroll`; `gsap.matchMedia` gates all pins | match (e2e: no `.pin-spacer` under reduced motion) |

## Verified by Playwright (Chromium, 1440×900 and 390×844) — `e2e/ui.spec.ts`
Loader, no horizontal overflow at 8 scroll positions, hero drag/keys, HUD, scroll choreography, reduced motion, `/app` flow (run → replay with override → `error → ok` divergence → guard 409 → retry with compensate → ledger `created 2 / deleted 1`), keyboard selection, axe scan (zero serious/critical on `/` and `/app`). Screenshots: `docs/screenshots/`.

## Not done / not verified
- REA reference study, measured tokens, reference screenshots.
- Lighthouse scores and LCP/bundle-size budgets were **not measured**.
- Intro "exactly one statement visible at a time" and the showcase chip order are implemented but not asserted in e2e.
- The statement paragraph is intentionally low-contrast until scrolled; excluded from the axe contrast rule (full text is available via a visually hidden copy).
- Mobile `/app` full replay flow is not exercised in e2e (desktop only); the mobile layout is a stacked single column.
- Fonts are `@fontsource` substitutes (Anton, Inter Tight, JetBrains Mono); no `size-adjust` tuning.
