import { defineConfig, devices } from "@playwright/test";

/**
 * Functional tests for DroneRoute (100% open-source map stack).
 *
 * The dev servers are reused when already running
 * (`schtasks /run /tn DroneRouteBackend` + `DroneRouteFrontend`),
 * otherwise `npm run dev` starts both backend (:3001) and frontend (:5173).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  // Limited parallelism: all workers share a single Vite dev server and
  // live tile CDN endpoints — more workers cause flaky network timeouts.
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -w packages/backend",
      url: "http://localhost:3001/api/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev -w packages/frontend",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
