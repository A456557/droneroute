import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  addWaypoints,
  assertHealthy,
  clickMap,
  gotoEditor,
  trackPageHealth,
} from "./helpers";

test.describe("Mission editing", () => {
  test("edits waypoint altitude then deletes the waypoint", async ({
    page,
  }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    await addWaypoints(page, canvas, [[0.5, 0.5]]);
    await expect(page.getByText("Waypoints (1)")).toBeVisible({
      timeout: 15_000,
    });

    // Selecting the waypoint auto-expands its inline editor: change altitude.
    const altitudeInput = page.locator("div.ml-4 input[type=number]").first();
    await expect(altitudeInput).toBeVisible({ timeout: 10_000 });
    await altitudeInput.fill("80");
    await expect(altitudeInput).toHaveValue("80");
    await expect(page.getByText("80 m")).toBeVisible({ timeout: 10_000 });

    // Delete it again.
    await page.getByTitle("Remove waypoint").click();
    await expect(page.getByText("Waypoints (0)")).toBeVisible({
      timeout: 10_000,
    });
    assertHealthy(health);
  });

  test("adds a POI and draws an obstacle", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    await page.getByTitle("Click on map to add POI (P)").click();
    await clickMap(canvas, 0.5, 0.4);
    await expect(page.getByText("Points of interest (1)")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTitle("Draw obstacle polygon (B)").click();
    await clickMap(canvas, 0.3, 0.6);
    await clickMap(canvas, 0.45, 0.7);
    await clickMap(canvas, 0.3, 0.75);
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await canvas.dblclick({
      position: { x: box!.width * 0.32, y: box!.height * 0.68 },
    });
    await expect(page.getByText("Obstacles (1)")).toBeVisible({
      timeout: 15_000,
    });
    assertHealthy(health);
  });

  test("round-trips an exported KMZ back through import", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    await addWaypoints(page, canvas, [
      [0.4, 0.4],
      [0.6, 0.6],
    ]);
    await expect(page.getByText("Waypoints (2)")).toBeVisible({
      timeout: 15_000,
    });

    const exportButton = page.getByRole("button", { name: /Export KMZ/ });
    await expect(exportButton).toBeEnabled({ timeout: 15_000 });
    const downloadPromise = page.waitForEvent("download", {
      timeout: 30_000,
    });
    await exportButton.click();
    const download = await downloadPromise;
    const kmzPath = await download.path();
    expect(kmzPath).toBeTruthy();

    await page.getByRole("button", { name: /Import KMZ/ }).click();
    await page.locator('input[type="file"]').setInputFiles(kmzPath!);
    await expect(page.getByText("Waypoints (2)")).toBeVisible({
      timeout: 20_000,
    });
    expect(readFileSync(kmzPath!).subarray(0, 2).toString()).toBe("PK");
    assertHealthy(health);
  });
});
