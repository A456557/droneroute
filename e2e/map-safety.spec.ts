import { test, expect, type Page } from "@playwright/test";
import {
  assertHealthy,
  clickMap,
  gotoEditor,
  trackPageHealth,
} from "./helpers";

async function enableRnbLayer(page: Page) {
  await page.getByRole("button", { name: /Bâtiments 2D/ }).click();
  const resp = await page.waitForResponse(
    (r) => r.url().includes("/api/buildings/rnb") && r.status() === 200,
    { timeout: 30_000 },
  );
  const data = (await resp.json()) as {
    buildings?: Array<{ rnbId: string }>;
  };
  expect(data.buildings!.length).toBeGreaterThan(0);
}

test.describe("Map safety: RNB layer and Escape", () => {
  test("Escape with RNB layer on does not crash and resets to neutral", async ({
    page,
  }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    // RNB layer on: any re-render used to throw "source id changed" and
    // unmount the whole map (black screen).
    await enableRnbLayer(page);
    await page.waitForTimeout(2000);

    // Enter placement mode, then Escape back to neutral.
    await page.getByRole("button", { name: /Add WP/ }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    // Map still alive…
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    // …and a click adds nothing (placement mode was cancelled).
    await clickMap(canvas, 0.3, 0.3);
    await expect(page.getByText("Waypoints (1)")).toHaveCount(0);

    assertHealthy(health);
  });

  test("clicking an RNB building shows its info panel", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    await enableRnbLayer(page);
    await page.waitForTimeout(3000);

    // Sweep a grid until a building centroid (~200 m tolerance) is hit.
    let found = false;
    for (const fx of [0.35, 0.5, 0.65]) {
      for (const fy of [0.35, 0.5, 0.65]) {
        await clickMap(canvas, fx, fy);
        try {
          await page
            .getByText("Bâtiment RNB")
            .first()
            .waitFor({ state: "visible", timeout: 2500 });
          found = true;
          break;
        } catch {
          // try next grid point
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
    expect(await page.getByText("Bâtiment RNB").count()).toBeGreaterThan(0);

    // Escape closes the panel back to a neutral map.
    await page.keyboard.press("Escape");
    await expect(page.getByText("Bâtiment RNB").first()).toBeHidden({
      timeout: 10_000,
    });
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    assertHealthy(health);
  });
});
