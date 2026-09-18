import { test, expect } from "@playwright/test";
import {
  addWaypoints,
  assertHealthy,
  gotoEditor,
  registerViaUI,
  trackPageHealth,
  uniqueEmail,
  TEST_PASSWORD,
} from "./helpers";

test.describe("Accounts and persistence", () => {
  test("registers, saves, lists and reloads a mission", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    await registerViaUI(page, uniqueEmail("persist"), TEST_PASSWORD);

    const missionName = `E2E Mission ${Date.now()}`;
    await page.getByPlaceholder("Mission name").fill(missionName);
    await addWaypoints(page, canvas, [
      [0.4, 0.4],
      [0.6, 0.6],
    ]);

    const saveResponse = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/missions") &&
        resp.request().method() === "POST" &&
        resp.status() === 201,
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await saveResponse;

    // The saved mission shows up in My routes…
    await page.getByTitle("My routes").click();
    await expect(page.getByText(missionName)).toBeVisible({
      timeout: 15_000,
    });

    // …and loads back into the editor with both waypoints.
    await page.getByText(missionName).click();
    await expect(page.getByText("Waypoints (2)")).toBeVisible({
      timeout: 15_000,
    });
    assertHealthy(health);
  });

  test("requires an account before saving", async ({ page }) => {
    const health = trackPageHealth(page);
    await gotoEditor(page);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("h2", { hasText: "Sign in" })).toBeVisible({
      timeout: 10_000,
    });
    assertHealthy(health);
  });
});
