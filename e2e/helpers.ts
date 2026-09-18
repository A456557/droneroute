import { expect, type Locator, type Page } from "@playwright/test";

const GOOGLE_HOSTS = ["maps.googleapis.com", "maps.gstatic.com"];

export interface PageHealth {
  pageErrors: Error[];
  googleRequests: string[];
}

/** Dismiss the first-visit welcome overlay if it shows up (polls, since
 *  React hydration can mount it after navigation resolves). */
export async function dismissWelcome(page: Page) {
  const heading = page.getByText("Welcome to DroneRoute");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await heading.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await expect(heading).toBeHidden({ timeout: 5_000 });
      return;
    }
    await page.waitForTimeout(500);
  }
}

/** Collect page errors and Google-Maps requests for the whole test. */
export function trackPageHealth(page: Page): PageHealth {
  const health: PageHealth = { pageErrors: [], googleRequests: [] };
  page.on("pageerror", (err) => health.pageErrors.push(err));
  page.on("request", (req) => {
    const url = req.url();
    if (GOOGLE_HOSTS.some((host) => url.includes(host))) {
      health.googleRequests.push(url);
    }
  });
  return health;
}

export function assertHealthy(health: PageHealth) {
  expect(health.pageErrors).toEqual([]);
  expect(health.googleRequests).toEqual([]);
}

/** Open the editor on a fresh mission and return the map canvas. */
export async function gotoEditor(page: Page): Promise<Locator> {
  await page.goto("/");
  await dismissWelcome(page);
  const canvas = page.locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  return canvas;
}

/** Click on the map canvas at fractional coordinates. */
export async function clickMap(
  canvas: Locator,
  fx: number,
  fy: number,
): Promise<void> {
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({
    position: { x: box!.width * fx, y: box!.height * fy },
  });
}

/** Enable waypoint placement and click each point. Mode stays active. */
export async function addWaypoints(
  page: Page,
  canvas: Locator,
  points: Array<[number, number]>,
): Promise<void> {
  await page.getByRole("button", { name: /Add WP/ }).click();
  for (const [fx, fy] of points) {
    await clickMap(canvas, fx, fy);
  }
}

/** Select a template, draw it with the given clicks, optionally finish,
 *  read the preview badge count, apply, and return the count. */
export async function applyTemplate(
  page: Page,
  canvas: Locator,
  optionName: RegExp,
  clicks: Array<[number, number]>,
  finishButtonName?: string,
): Promise<number> {
  await page.getByRole("button", { name: "Template" }).click();
  await page.getByRole("button", { name: optionName }).click();
  for (const [fx, fy] of clicks) {
    await clickMap(canvas, fx, fy);
  }
  if (finishButtonName) {
    await page
      .getByRole("button", { name: finishButtonName, exact: true })
      .click();
  }
  const badge = page.getByText(/^\d+ waypoints$/);
  await expect(badge).toBeVisible({ timeout: 15_000 });
  const count = parseInt((await badge.textContent())!, 10);
  expect(count).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  return count;
}

/** Register a throwaway user through the auth modal (opened via Save). */
export async function registerViaUI(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const heading = page.locator("h2", { hasText: "Sign in" });
  await expect(heading).toBeVisible({ timeout: 10_000 });
  await page.getByText("Don't have an account? Sign up").click();
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(heading).toBeHidden({ timeout: 15_000 });
}

export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}@example.com`;
}

export const TEST_PASSWORD = "test1234";
