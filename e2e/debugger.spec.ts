import { expect, test, type Page } from "@playwright/test";

// Needs the server started with FAKE_GITHUB=1 ./scripts/restart-server.sh (a token starting with "fake" talks to e2e/fake-github.cjs).
const TOKEN = `fake${"a".repeat(30)}`;

async function connect(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("swytmSeen", "1");
    localStorage.setItem("swytmCookie", "reject");
  });
  await page.goto("/app");
  await page.getByLabel("GitHub token").fill(TOKEN);
  await page.getByLabel("Repository (owner/name)").fill("https://github.com/demo/repo");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".banner.live")).toContainText("@demo-user");
}

test("debugger: connect, break a step, read snapshots, replay values, guard, undo", async ({ page }) => {
  await connect(page);

  // run with the last step broken on purpose
  await page.getByLabel(/Break the last step/).check();
  await page.getByRole("button", { name: "Run on GitHub" }).click();
  await expect(page.getByTestId("step-error")).toContainText("GitHub issue state must be");
  await expect(page.getByTestId("run-stats")).toContainText("3 GitHub calls");

  // snapshot reader: where does each value come from?
  await page.locator("#st-1").click();
  const reader = page.getByTestId("reader");
  await expect(reader).toContainText("steps.create.output.number");
  await expect(reader).toContainText("from inputs.label");
  await page.locator("#st-2").click();

  // replay plan before pressing anything: 2 reused, 1 call, value change shown
  const plan = page.getByTestId("plan");
  await expect(plan).toContainText("1 GitHub call(s), 2 step(s) reused");
  await expect(plan).toContainText("inputs.finalState");
  await expect(page.getByLabel("Override path 1")).toHaveValue("inputs.finalState");

  // replay: one real call, two recorded values injected
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByTestId("run-stats")).toContainText("1 GitHub calls");
  await expect(page.getByTestId("run-stats")).toContainText("2 steps reused");
  await expect(page.locator(".drawer")).toContainText("IN SYNC");

  // an injected snapshot says it was reused
  await page.locator("#st-0").click();
  await expect(page.getByTestId("reader")).toContainText("Reused, not executed");

  // replay from step 0 would repeat real effects: plan warns, guard stops it, undo fixes it
  await expect(page.getByTestId("plan-blocked")).toBeVisible();
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByTestId("guard")).toBeVisible();
  await page.getByRole("button", { name: "Undo them, then replay" }).click();
  await expect(page.getByTestId("run-stats")).toContainText("0 steps reused");
  await expect(page.locator(".stats .okc")).toContainText("ok");

  // chain verifies
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.locator(".toast")).toContainText("Hash chain OK");
});

test("debugger: a snapshot value can be sent to the replay overrides", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Run on GitHub" }).click();
  await expect(page.getByTestId("run-stats")).toContainText("ok");
  await page.locator("#st-2").click();
  await page.getByTestId("reader").getByRole("button", { name: "change on replay" }).first().click();
  await expect(page.locator(".toast")).toContainText("Added");
  await expect(page.getByTestId("plan")).toContainText("Values that change");
});
