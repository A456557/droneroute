import { test, expect } from "@playwright/test";
import {
  assertHealthy,
  clickMap,
  gotoEditor,
  trackPageHealth,
} from "./helpers";

async function enableRnbLayer(page: Parameters<typeof gotoEditor>[0]) {
  // Listener registered before clicking (fetch fires fast); one retry in
  // case of a transient upstream throttle (non-200 from the RNB API).
  for (let attempt = 0; attempt < 2; attempt++) {
    const respPromise = page.waitForResponse(
      (r) => r.url().includes("/api/buildings/rnb"),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /Bâtiments 2D/ }).click();
    const resp = await respPromise;
    if (resp.status() === 200) {
      const data = (await resp.json()) as {
        buildings?: Array<{ rnbId: string }>;
      };
      if (data.buildings!.length > 0) return;
    }
    // Toggle off so the next attempt refetches.
    await page.getByRole("button", { name: /Bâtiments 2D/ }).click();
  }
  throw new Error("RNB layer did not load any buildings");
}

async function readPanelRnbId(
  page: Parameters<typeof gotoEditor>[0],
): Promise<string | null> {
  const texts = await page.locator("div.p-3").allInnerTexts();
  const match = texts.join(" ").match(/RNB:\s*([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

test.describe("Map safety: RNB layer and Escape", () => {
  test(
    "Escape with RNB layer on does not crash and resets to neutral",
    async ({ page }) => {
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
    },
    { timeout: 120_000 },
  );

  test(
    "clicking another RNB building updates the info panel",
    async ({ page }) => {
      const health = trackPageHealth(page);
      const canvas = await gotoEditor(page);

      await enableRnbLayer(page);
      await page.waitForTimeout(3000);

      // Sweep a grid until two distinct buildings have been selected:
      // each click must update (not close) the info panel.
      const seen = new Set<string>();
      for (const fx of [0.3, 0.42, 0.5, 0.58, 0.7]) {
        for (const fy of [0.3, 0.42, 0.5, 0.58, 0.7]) {
          await clickMap(canvas, fx, fy);
          const id = await readPanelRnbId(page);
          if (id) seen.add(id);
          if (seen.size >= 2) break;
        }
        if (seen.size >= 2) break;
      }
      expect(seen.size).toBeGreaterThanOrEqual(2);

      // Escape closes the panel back to a neutral map.
      await page.keyboard.press("Escape");
      await expect(page.getByText("Bâtiment RNB").first()).toBeHidden({
        timeout: 10_000,
      });
      await expect(canvas).toBeVisible({ timeout: 15_000 });

      assertHealthy(health);
    },
    { timeout: 180_000 },
  );
});
