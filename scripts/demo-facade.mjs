// Demo facade DroneRoute — Eglise Saint-Andre, Labarthe-sur-Leze.
// Parcours complet : recherche -> vol carte -> gabarit Facade ->
// Building assist (Auto-fit) -> Apply -> analyse IA -> 3D -> export KMZ.
// Usage: node scripts/demo-facade.mjs
// Sorties: demo-visuelle-facade/*.png, demo-tour-facade.webm, eglise-facade.kmz
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "demo-visuelle-facade",
);
mkdirSync(root, { recursive: true });

const CHURCH = { lat: 43.4519371, lon: 1.3992832 };

// Centre de carte attendu : 1er resultat BAN de la recherche utilisee dans l'UI.
const ban = await fetch(
  "https://api-adresse.data.gouv.fr/search/?q=" +
    encodeURIComponent("Place du Fort 31860 Labarthe-sur-Leze") +
    "&limit=1",
).then((r) => r.json());
const CENTER = {
  lat: ban.features[0].geometry.coordinates[1],
  lon: ban.features[0].geometry.coordinates[0],
};
console.log("centre carte:", CENTER.lat, CENTER.lon);

function world(lng, lat, zoom) {
  const s = 256 * Math.pow(2, zoom);
  const rad = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * s,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * s,
  };
}

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

async function screenOf(lat, lon, zoom, box, center) {
  const w = world(lon, lat, zoom);
  const c = world(center.lon, center.lat, zoom);
  return {
    x: box.x + box.width / 2 + (w.x - c.x),
    y: box.y + box.height / 2 + (w.y - c.y),
  };
}

await page.goto("http://droneroute.localhost/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.locator("canvas").first().waitFor({ timeout: 45000 });
await page.waitForTimeout(3000);
const start = page.getByRole("button", { name: "Get started" });
if (await start.count()) {
  await start.click();
  await page.waitForTimeout(1000);
}

// 1. Recherche + vol vers l'eglise.
await page
  .getByPlaceholder("Search location...")
  .fill("Place du Fort 31860 Labarthe-sur-Leze");
await page.getByRole("button", { name: "Search" }).click();
await page.getByText("Place du Fort").first().waitFor({ timeout: 20000 });
await shot("00-recherche.png");
// Les resultats BAN s'affichent sous la barre ; clique le premier.
const resultBtn = page
  .locator("button")
  .filter({ hasText: "Place du Fort" })
  .first();
await resultBtn.click();
await page.waitForTimeout(5000);

// Zoom avant (x2) centre sur l'eglise.
const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(2500);
await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(2500);

// 2. Fond satellite pour voir l'eglise.
await page.getByRole("button", { name: "Satellite" }).click();
await page.waitForTimeout(5000);
await shot("01-eglise-satellite.png");

// 3. Gabarit Facade : trace le long du flanc sud de l'eglise (z=17).
await page.getByRole("button", { name: "Template" }).click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: /Facade scan/ }).click();
await page.waitForTimeout(1000);
const A = await screenOf(43.4518, 1.3989, 17, box, CENTER);
const B = await screenOf(43.4518, 1.39968, 17, box, CENTER);
console.log(
  "clics:",
  Math.round(A.x),
  Math.round(A.y),
  "->",
  Math.round(B.x),
  Math.round(B.y),
);
// Mode Facade : 1er clic = point de depart, 2e clic = fin du gabarit.
await page.mouse.click(A.x, A.y);
await page.waitForTimeout(1200);
await page.mouse.click(B.x, B.y);
await page.waitForTimeout(2500);
await shot("02-facade-tracee.png");

// 4. Building assist (Auto-fit) : detection OSM + segments + reco Copilot.
await page.getByRole("button", { name: "Auto-fit" }).click();
console.log("auto-fit lance...");
try {
  await page.getByText("Detected facades").first().waitFor({ timeout: 90000 });
  console.log("segments detectes");
} catch {
  console.log("pas de segments (upstream OSM indisponible ?)");
}
await page.waitForTimeout(1500);
await shot("03-building-assist.png");

// 5. Choisit le 1er segment detecte si present, puis Apply.
const segBtn = page
  .locator("div")
  .filter({ hasText: /^Detected facades$/ })
  .locator("..")
  .getByRole("button")
  .first();
if (await segBtn.count()) {
  await segBtn.click();
  await page.waitForTimeout(1500);
}
await page.getByRole("button", { name: "Apply", exact: true }).click();
await page.waitForTimeout(2500);
// La vue peut decrocher au Apply (fitBounds mission) : on re-vole sur l'eglise.
await page
  .getByPlaceholder("Search location...")
  .fill("Place du Fort 31860 Labarthe-sur-Leze");
await page.getByRole("button", { name: "Search" }).click();
await page.getByText("Place du Fort").first().waitFor({ timeout: 20000 });
await page
  .locator("button")
  .filter({ hasText: "Place du Fort" })
  .first()
  .click();
await page.waitForTimeout(5000);
const box2 = await page.locator("canvas").first().boundingBox();
await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2);
await page.waitForTimeout(2500);
await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2);
await page.waitForTimeout(4000);
await shot("04-mission-facade.png");

// 6. Analyse IA (Mission assistant).
await page.getByRole("button", { name: "Mission assistant" }).click();
await page.waitForTimeout(1000);
await page.getByRole("button", { name: /scan facade plus propre/ }).click();
await page.getByRole("button", { name: "Analyser" }).click();
await page.getByText("Actions suggérées").first().waitFor({ timeout: 480000 });
await page.getByText("Actions suggérées").first().scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await shot("05-analyse-ia-facade.png");

// 7. Vue 3D.
await page.getByRole("button", { name: "3D", exact: true }).click();
await page.waitForTimeout(5000);
await shot("06-facade-3d.png");

// 8. Export KMZ (telechargement).
try {
  const dl = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Export KMZ" }).click();
  const download = await dl;
  await download.saveAs(join(root, "eglise-facade.kmz"));
  console.log("kmz ok");
} catch {
  console.log("export KMZ sans telechargement (mode invite ?)");
}
await page.waitForTimeout(1000);
await shot("07-export-kmz.png");

await context.close();
await browser.close();

for (const f of readdirSync(root)) {
  if (f.endsWith(".webm") && f !== "demo-tour-facade.webm") {
    const target = join(root, "demo-tour-facade.webm");
    if (existsSync(target)) unlinkSync(target);
    renameSync(join(root, f), target);
    console.log("video: demo-tour-facade.webm");
  }
}
console.log("termine:", root);
