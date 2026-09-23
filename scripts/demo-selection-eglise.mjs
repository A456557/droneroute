// Test facade batiment selectionne — Eglise Saint-Andre (RNB 6V24K875XHK9).
// Pre-requis: DEFAULT_MAP_VIEW=43.4519454,1.3992749,18 (vue exacte eglise).
// Parcours simple utilisateur : RNB -> clic eglise -> Template/Facade ->
// "Batiment selectionne" -> Scan des facades -> Façades denses -> Apply ->
// analyse IA -> 3D -> export KMZ.
// Usage: node scripts/demo-selection-eglise.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "demo-visuelle-selection",
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
await page.waitForTimeout(5000);
const start = page.getByRole("button", { name: "Get started" });
if (await start.count()) {
  await start.click();
  await page.waitForTimeout(1000);
}

// Fond satellite sur l'eglise (vue exacte z18 via DEFAULT_MAP_VIEW).
await page.getByRole("button", { name: "Satellite" }).click();
await page.waitForTimeout(5000);
await shot("01-eglise-satellite.png");

// Couche RNB puis clic au centre (l'eglise est pile au centre).
await page.getByRole("button", { name: "Bâtiments 2D" }).click();
await page.waitForTimeout(5000);
await shot("02-couche-rnb.png");
const box = await page.locator("canvas").first().boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(3000);
await shot("03-eglise-selectionnee.png");

try {
  await page.getByText("6V24K875XHK9").first().waitFor({ timeout: 15000 });
  console.log("eglise selectionnee OK (RNB 6V24K875XHK9)");
} catch {
  console.log("ECHEC selection eglise");
}

// Attend la hauteur BD TOPO (11 m) si l'upstream repond.
try {
  await page
    .getByText("11", { exact: false })
    .first()
    .waitFor({ timeout: 60000 });
  console.log("hauteur BD TOPO affichee");
} catch {
  console.log("hauteur BD TOPO non chargee (upstream ?)");
}
await shot("04-info-batiment.png");

// Template -> Facade scan -> rouvre le menu -> "Batiment selectionne".
await page.getByRole("button", { name: "Template" }).click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: /Facade scan/ }).click();
await page.waitForTimeout(1000);
// Le toggle affiche desormais "Facade" : on le reclique pour rouvrir le menu.
await page.getByRole("button", { name: "Facade", exact: true }).click();
await page.waitForTimeout(800);
await shot("05-menu-scan.png");
await page.getByRole("button", { name: /Bâtiment sélectionné/ }).click();
await page.waitForTimeout(3000);
await shot("06-panneau-scan.png");

// Mode "Scan des facades" + variante "Façades denses".
await page.getByRole("button", { name: /Scan des façades/ }).click();
await page.waitForTimeout(2000);
await shot("07-mode-facades.png");
await page.getByRole("button", { name: /Façades denses/ }).click();
await page.waitForTimeout(2000);
await shot("08-variante-dense.png");

// Apply -> mission.
await page.getByRole("button", { name: "Apply", exact: true }).click();
await page.waitForTimeout(3000);
await shot("09-mission-facade.png");

// Analyse IA.
await page.getByRole("button", { name: "Mission assistant" }).click();
await page.waitForTimeout(1000);
await page.getByRole("button", { name: /scan facade plus propre/ }).click();
await page.getByRole("button", { name: "Analyser" }).click();
await page.getByText("Actions suggérées").first().waitFor({ timeout: 480000 });
await page.getByText("Actions suggérées").first().scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await shot("10-analyse-ia.png");

// 3D + export KMZ.
await page.getByRole("button", { name: "3D", exact: true }).click();
await page.waitForTimeout(5000);
await shot("11-facade-3d.png");
try {
  const dl = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Export KMZ" }).click();
  const download = await dl;
  await download.saveAs(join(root, "eglise-selection-facade.kmz"));
  console.log("kmz ok");
} catch {
  console.log("export KMZ sans telechargement");
}
await shot("12-export-kmz.png");

await context.close();
await browser.close();

for (const f of readdirSync(root)) {
  if (f.endsWith(".webm") && f !== "demo-selection.webm") {
    const target = join(root, "demo-selection.webm");
    if (existsSync(target)) unlinkSync(target);
    renameSync(join(root, f), target);
    console.log("video: demo-selection.webm");
  }
}
console.log("termine:", root);
