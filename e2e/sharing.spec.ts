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

const API = "http://localhost:3001";

test.describe("Mission sharing", () => {
  test("shares, previews, clones and unshares a mission", async ({ page }) => {
    const health = trackPageHealth(page);
    const canvas = await gotoEditor(page);

    // UI setup: account + named mission with 2 waypoints, saved.
    await registerViaUI(page, uniqueEmail("share"), TEST_PASSWORD);
    const missionName = `E2E Share ${Date.now()}`;
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

    const token = await page.evaluate(() =>
      localStorage.getItem("droneroute_token"),
    );
    expect(token).toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const listRes = await fetch(`${API}/api/missions`, { headers: auth });
    expect(listRes.status).toBe(200);
    const missions = (await listRes.json()) as Array<{
      id: string;
      name: string;
    }>;
    const mission = missions.find((m) => m.name === missionName);
    expect(mission).toBeTruthy();

    // Share (UI hides this in self-hosted mode, the API is the contract).
    const shareRes = await fetch(`${API}/api/missions/${mission!.id}/share`, {
      method: "POST",
      headers: auth,
    });
    expect(shareRes.status).toBe(200);
    const { shareToken } = (await shareRes.json()) as {
      shareToken: string;
    };
    expect(shareToken).toBeTruthy();

    // Public preview works without auth and renders the shared map.
    const publicRes = await fetch(`${API}/api/shared/${shareToken}`);
    expect(publicRes.status).toBe(200);
    await page.goto(`/shared/${shareToken}`);
    await expect(
      page.getByRole("heading", { name: "Shared route" }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(missionName)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible({
      timeout: 30_000,
    });

    // Clone into the account, then revoke the link.
    const cloneRes = await fetch(`${API}/api/shared/${shareToken}/clone`, {
      method: "POST",
      headers: auth,
    });
    expect(cloneRes.status).toBe(201);

    await page.goto("/");
    await page.getByTitle("My routes").click();
    await expect(page.getByText(`${missionName} (copy)`)).toBeVisible({
      timeout: 15_000,
    });

    const unshareRes = await fetch(`${API}/api/missions/${mission!.id}/share`, {
      method: "DELETE",
      headers: auth,
    });
    expect(unshareRes.status).toBe(200);
    await page.goto(`/shared/${shareToken}`);
    await expect(page.getByText("Route not found")).toBeVisible({
      timeout: 20_000,
    });

    assertHealthy(health);
  });
});
