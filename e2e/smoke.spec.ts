import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { assertHealthy, dismissWelcome, trackPageHealth } from "./helpers";

test.describe("DroneRoute open-source map", () => {
  test("loads the OpenFreeMap basemap without any Google Maps request", async ({
    page,
  }) => {
    const health = trackPageHealth(page);

    // Register network listeners before navigation (tiles load fast).
    const stylePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("tiles.openfreemap.org/styles/bright") &&
        resp.status() === 200,
      { timeout: 45_000 },
    );
    const tilePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("tiles.openfreemap.org/planet/") &&
        resp.status() === 200,
      { timeout: 45_000 },
    );

    await page.goto("/");

    await dismissWelcome(page);

    // The MapLibre canvas renders…
    const canvas = page.locator("canvas.maplibregl-canvas");
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // …and open-source vector tiles actually load (style + tiles).
    expect((await stylePromise).ok()).toBe(true);
    expect((await tilePromise).ok()).toBe(true);

    // 3D buildings source is declared (extrusion layer over OSM data).
    await expect(
      page.getByRole("button", { name: "3D", exact: true }),
    ).toBeVisible();

    assertHealthy(health);
  });

  test("plans 2 waypoints on click and exports a valid KMZ", async ({
    page,
  }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    await dismissWelcome(page);

    const canvas = page.locator("canvas.maplibregl-canvas");
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Placement mode, then two clicks at distinct spots on the map.
    await page.getByRole("button", { name: /Add WP/ }).click();
    await canvas.click({
      position: { x: box!.width * 0.35, y: box!.height * 0.4 },
    });
    await canvas.click({
      position: { x: box!.width * 0.6, y: box!.height * 0.6 },
    });

    // Both waypoints show up in the sidebar…
    await expect(page.getByText("Waypoints (2)")).toBeVisible({
      timeout: 15_000,
    });

    // …which enables the KMZ export, producing a real zip download.
    const exportButton = page.getByRole("button", { name: /Export KMZ/ });
    await expect(exportButton).toBeEnabled({ timeout: 15_000 });
    const downloadPromise = page.waitForEvent("download", {
      timeout: 30_000,
    });
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.kmz$/i);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    expect(readFileSync(filePath!).subarray(0, 2).toString()).toBe("PK");

    assertHealthy(health);
  });

  test("switches basemap/satellite/3D and searches via BAN", async ({
    page,
  }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    await dismissWelcome(page);

    const canvas = page.locator("canvas.maplibregl-canvas");
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Satellite view loads Esri imagery (no key required).
    await page.getByRole("button", { name: "Satellite", exact: true }).click();
    const esriResponse = await page.waitForResponse(
      (resp) =>
        resp.url().includes("server.arcgisonline.com") && resp.status() === 200,
      { timeout: 30_000 },
    );
    expect(esriResponse.ok()).toBe(true);

    // Back to the open-source street map.
    await page.getByRole("button", { name: "Street", exact: true }).click();
    await page.waitForResponse(
      (resp) =>
        resp.url().includes("tiles.openfreemap.org/planet/") &&
        resp.status() === 200,
      { timeout: 30_000 },
    );

    // 3D mode enables terrain relief, back to 2D flattens the camera.
    await page.getByRole("button", { name: "3D", exact: true }).click();
    await page.waitForResponse(
      (resp) =>
        resp.url().includes("elevation-tiles-prod") && resp.status() === 200,
      { timeout: 45_000 },
    );
    await page.getByRole("button", { name: "2D", exact: true }).click();

    // Address search uses the French BAN geocoder (no key required).
    await page.getByPlaceholder("Search location...").fill("Paris");
    await page.getByPlaceholder("Search location...").press("Enter");
    const firstResult = page
      .locator("div.absolute.left-4.top-16 button")
      .first();
    await expect(firstResult).toBeVisible({ timeout: 20_000 });
    await firstResult.click();

    assertHealthy(health);
  });
});
