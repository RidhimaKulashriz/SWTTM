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

test("/app: run → replay with override → divergence; guard 409 → compensate; ledger", async ({ page }) => {
  test.skip(vp(page) === "mobile", "full flow is exercised at 1440×900");
  await quiet(page);
  await page.goto("/app");
  await expect(page.locator(".banner")).toContainText("LIVE API CONNECTED");
  await expect(page.locator("#st-0")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${vp(page)}-app-static.png` });
  const previewRunId = await page.locator("#runsel").inputValue();
  await page.getByRole("button", { name: "Run mock demo" }).click();
  await expect(page.locator("#runsel")).not.toHaveValue(previewRunId, { timeout: 15_000 });
  await expect(page.locator("#st-2")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".banner")).toContainText("LIVE API CONNECTED");
  const orig = await page.locator("#runsel").inputValue();
  await page.locator("#st-2").click();
  await page.getByLabel("Override path 1").fill("inputs.finalState");
  await page.getByLabel("Override value 1").fill("closed");
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByLabel("Divergence")).toContainText("status: error → ok", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/${vp(page)}-app-replay.png` });
  await expect(page.getByTestId("ledger-created")).toHaveText("1");
  await page.goto(`/app?run=${orig}&step=0`);
  await expect(page.locator("#st-0")).toBeVisible();
  await expect(page.locator("#runsel")).toHaveValue(orig);
  await page.locator("#from").selectOption("0");
  await page.getByLabel("Override path 1").fill("inputs.finalState");
  await page.getByLabel("Override value 1").fill("closed");
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByTestId("guard")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${vp(page)}-app-guard.png` });
  await page.getByRole("button", { name: /retry with compensate/i }).click();
  await expect(page.getByTestId("ledger-deleted")).toHaveText("1", { timeout: 15_000 });
  await expect(page.getByTestId("ledger-created")).toHaveText("2");
});

test("/app keyboard: arrow keys select steps; focus is visible", async ({ page }) => {
  await quiet(page);
  await page.goto("/app");
  await page.waitForTimeout(800);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#st-1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe("none");
});
