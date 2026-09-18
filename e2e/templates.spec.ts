import { test, expect } from "@playwright/test";
import {
  applyTemplate,
  assertHealthy,
  gotoEditor,
  trackPageHealth,
} from "./helpers";

test.describe("Mission templates", () => {
  test("orbit template generates 12 waypoints and a POI", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    const count = await applyTemplate(page, canvas, /Orbit/, [
      [0.5, 0.45],
      [0.62, 0.55],
    ]);
    expect(count).toBe(12);

    await expect(page.getByText("Waypoints (12)")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Points of interest (1)")).toBeVisible({
      timeout: 15_000,
    });
    assertHealthy(health);
  });

  test("grid template generates a waypoint lawn-mower", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    const count = await applyTemplate(page, canvas, /Grid survey/, [
      [0.3, 0.35],
      [0.7, 0.65],
    ]);

    await expect(page.getByText(`Waypoints (${count})`)).toBeVisible({
      timeout: 15_000,
    });
    assertHealthy(health);
  });

  test("facade template generates a vertical scan", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    const count = await applyTemplate(page, canvas, /Facade scan/, [
      [0.35, 0.4],
      [0.65, 0.6],
    ]);

    await expect(page.getByText(`Waypoints (${count})`)).toBeVisible({
      timeout: 15_000,
    });
    assertHealthy(health);
  });

  test("pencil template follows a freehand path", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    const count = await applyTemplate(
      page,
      canvas,
      /Pencil path/,
      [
        [0.35, 0.5],
        [0.5, 0.4],
        [0.65, 0.5],
      ],
      "Finish path",
    );

    await expect(page.getByText(`Waypoints (${count})`)).toBeVisible({
      timeout: 15_000,
    });
    assertHealthy(health);
  });
});
