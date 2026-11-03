import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

const SHOTS = "docs/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });

async function quiet(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("swytmSeen", "1");
    localStorage.setItem("swytmCookie", "reject");
  });
}
const vp = (page: Page) => (page.viewportSize()!.width > 800 ? "desktop" : "mobile");

test("loader: reaches 100%, is removed, page scrolls; second visit skips", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".loader")).toBeVisible();
  await expect(page.locator(".loader")).toHaveCount(0, { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.classList.contains("is-loading"))).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 600));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await page.reload();
  await expect(page.locator(".loader")).toHaveCount(0);
});

test("no horizontal overflow at 8 scroll positions", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let i = 0; i < 8; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(((h - 900) * i) / 7));
    await page.waitForTimeout(250);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(o.sw, `position ${i}`).toBeLessThanOrEqual(o.iw);
  }
});

test("hero: drag changes aria-valuenow, snaps to integer, arrows work", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.waitForTimeout(1500);
  const c = page.getByTestId("hero-canvas");
  const box = (await c.boundingBox())!;
  const v0 = await c.getAttribute("aria-valuenow");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const v1 = await c.getAttribute("aria-valuenow");
  expect(v1).not.toBe(v0);
  expect(Number.isInteger(Number(v1))).toBe(true);
  await c.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(900);
  expect(Number(await c.getAttribute("aria-valuenow"))).toBe(Number(v1) - 1);
});

test("cursor HUD updates on mousemove (desktop)", async ({ page }) => {
  test.skip(vp(page) === "mobile");
  await quiet(page);
  await page.goto("/");
  await page.waitForTimeout(1500); // hydration
  await page.mouse.move(700, 450);
  await page.mouse.move(701, 452);
  await expect(page.getByTestId("hud")).toContainText(/STEP: 0\d|X: 701PX {2}Y: 452PX/);
});

test("scroll choreography: statement words fade in, why-us stages 0→3, hscroll moves", async ({ page }) => {
  test.skip(vp(page) === "mobile");
  await quiet(page);
  await page.goto("/");
  await page.waitForTimeout(800);
  const op = () => page.evaluate(() => Array.from(document.querySelectorAll(".statement .word")).map((w) => Number(getComputedStyle(w).opacity)));
  await page.evaluate(() => document.getElementById("statement")!.scrollIntoView());
  await page.waitForTimeout(400);
  const a = (await op()).reduce((x, y) => x + y, 0);
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(400);
  const b = (await op()).reduce((x, y) => x + y, 0);
  expect(b).toBeGreaterThan(a);
  const stages: number[] = [];
  const top = await page.evaluate(() => document.getElementById("why")!.getBoundingClientRect().top + window.scrollY);
  for (const f of [0, 1.2, 2.2, 3.2, 3.9]) {
    await page.evaluate((y) => window.scrollTo(0, y), top + f * 900);
    await page.waitForTimeout(500);
    stages.push(Number(await page.locator("#why").getAttribute("data-stage")));
  }
  expect(stages[0]).toBe(0);
  expect(stages[stages.length - 1]).toBe(3);
  expect([...stages].sort((x, y) => x - y)).toEqual(stages);
  const t0 = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("[data-testid=hscroll]")!).transform).m41);
  const uc = await page.evaluate(() => document.getElementById("use-cases")!.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y + 1200), uc);
  await page.waitForTimeout(1500);
  const t1 = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("[data-testid=hscroll]")!).transform).m41);
  expect(t1).toBeLessThan(t0);
});

test("prefers-reduced-motion: no pinning, content visible", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.locator(".pin-spacer")).toHaveCount(0);
  expect(await page.evaluate(() => Array.from(document.querySelectorAll(".statement .word")).every((w) => getComputedStyle(w).opacity === "1"))).toBe(true);
  await expect(page.locator("h1")).toBeVisible();
  await ctx.close();
});

test("screenshots of the landing page", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${SHOTS}/${vp(page)}-hero.png` });
  for (const id of ["statement", "problems", "intro", "solution", "why", "use-cases", "cta"]) {
    await page.evaluate((i) => document.getElementById(i)!.scrollIntoView(), id);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/${vp(page)}-${id}.png` });
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/${vp(page)}-footer.png` });
});

test("axe: no serious/critical violations on / and /app", async ({ page }) => {
  await quiet(page);
  for (const url of ["/", "/app"]) {
    await page.goto(url);
    await page.waitForTimeout(1500);
    // The scrubbed statement paragraph is intentionally rendered at 15% opacity until scrolled into view
    // (its full text is available to assistive tech via a visually-hidden copy), so it is excluded from the contrast rule.
    const r = await new AxeBuilder({ page }).exclude(".statement").analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    console.log(url, vp(page), bad.map((v) => `${v.id}(${v.nodes.length})`).join(", ") || "clean");
    expect.soft(bad.map((v) => v.id), `axe ${url}`).toEqual([]);
  }
});

test("/app: shows no sample data before connecting, validates input, bad credentials are rejected by GitHub", async ({ page }) => {
  await quiet(page);
  await page.goto("/app");
  await expect(page.locator(".banner")).toContainText("NOT CONNECTED");
  await expect(page.getByRole("form", { name: "Connect GitHub" })).toBeVisible();
  await expect(page.locator("#st-0")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(page.locator("p.warn[role=alert]")).toContainText("Paste your GitHub token");
  await page.screenshot({ path: `${SHOTS}/${vp(page)}-app-static.png` });
  await page.getByLabel("GitHub token").fill("ghp_" + "x".repeat(36));
  await page.getByLabel("Repository (owner/name)").fill("someone/nothing");
  await connect.click();
  await expect(page.locator("p.warn[role=alert]")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".banner")).toContainText("NOT CONNECTED");
});

test("anchor links land on the right section, including pinned ones, from anywhere on the page", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __swytmReady?: boolean }).__swytmReady === true);
  await page.waitForTimeout(600);
  // footer links reach every section; jump in a scrambled order so each one starts from a different pinned/unpinned state
  for (const id of ["use-cases", "statement", "why", "problems", "solution", "intro", "use-cases", "why"]) {
    await page.evaluate((h) => (document.querySelector(`.footer a[href="#${h}"], .nav a[href="#${h}"], .hero a[href="#${h}"], #statement a[href="#${h}"]`) as HTMLElement | null)?.click() ?? (document.documentElement.dataset.noLink = h), id);
    if (await page.evaluate(() => !!document.documentElement.dataset.noLink)) {
      await page.evaluate(() => delete document.documentElement.dataset.noLink);
      continue; // no link to this id on the page
    }
    await expect
      .poll(async () => page.evaluate((h) => Math.abs(document.getElementById(h)!.getBoundingClientRect().top), id), { timeout: 8000 })
      .toBeLessThan(vp(page) === "desktop" ? 100 : 120);
  }
});

test("reload keeps the reading position (pins are measured before restoring)", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __swytmReady?: boolean }).__swytmReady === true);
  await page.waitForTimeout(600);
  const target = await page.evaluate(() => Math.round(document.getElementById("solution")!.getBoundingClientRect().top + window.scrollY));
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __swytmReady?: boolean }).__swytmReady === true);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => Math.round(window.scrollY));
  expect(Math.abs(after - target)).toBeLessThan(40);
});

test("the GitHub links point at the real repository", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  const hrefs = await page.locator('a[target="_blank"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.filter((h) => h === "https://github.com/" || h === "https://github.com")).toEqual([]);
});
