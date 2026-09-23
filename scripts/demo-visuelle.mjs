// Demo visuelle DroneRoute — capture d'ecran + video du parcours refonte.
// Usage: node scripts/demo-visuelle.mjs
// Sorties: demo-visuelle/*.png, demo-visuelle/demo-tour.webm
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "demo-visuelle",
);
mkdirSync(root, { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: root, size: { width: 1600, height: 900 } },
});
const page = await context.newPage();

const shot = async (name) => {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(root, name) });
  console.log("capture:", name);
};

await page.goto("http://droneroute.localhost/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.locator("canvas").first().waitFor({ timeout: 45000 });
await page.waitForTimeout(3000);
// Ferme la modale de bienvenue si presente.
const start = page.getByRole("button", { name: "Get started" });
if (await start.count()) {
  await start.click();
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(4000);
await shot("01-plan-ign.png");

await page.getByRole("button", { name: "Satellite" }).click();
await page.waitForTimeout(5000);
await shot("02-bd-ortho.png");

await page.getByRole("button", { name: "Street" }).click();
await page.waitForTimeout(2000);

// Trace une mission de demo : 4 waypoints en carre autour du centre.
await page.getByTitle("Click on map to add waypoints (W)").click();
const box = await page.locator("canvas").first().boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const d = 180;
await page.mouse.click(cx - d, cy - d);
await page.waitForTimeout(600);
await page.mouse.click(cx + d, cy - d);
await page.waitForTimeout(600);
await page.mouse.click(cx + d, cy + d);
await page.waitForTimeout(600);
await page.mouse.click(cx - d, cy + d);
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.waitForTimeout(2000);
await shot("03-mission-tracee.png");

// Analyse IA : ouvre le panneau assistant (contexte MNT + site envoyes
// automatiquement) et patiente jusqu'a la reponse du modele local.
await page.getByRole("button", { name: "Mission assistant" }).click();
await page.waitForTimeout(1000);
await page.getByRole("button", { name: "Analyser" }).click();
await page.getByText("Actions suggérées").first().waitFor({ timeout: 480000 });
// Remonte le resultat dans le panneau (scroll interne max-h-40vh).
await page.getByText("Actions suggérées").first().scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await shot("04-analyse-ia.png");

await page.getByRole("button", { name: "3D", exact: true }).click();
await page.waitForTimeout(5000);
await shot("05-vue-3d.png");

await page.getByRole("button", { name: "2D", exact: true }).click();
await page.waitForTimeout(2500);
await shot("06-retour-2d.png");

await context.close();
await browser.close();

// Renomme la video generee (nom aleatoire -> demo-tour.webm).
for (const f of readdirSync(root)) {
  if (f.endsWith(".webm")) {
    const target = join(root, "demo-tour.webm");
    if (join(root, f) !== target) {
      if (existsSync(target)) {
        const { unlinkSync } = await import("fs");
        unlinkSync(target);
      }
      renameSync(join(root, f), target);
    }
    console.log("video: demo-tour.webm");
  }
}
console.log("termine:", root);
