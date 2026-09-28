// Test affichage : Street/Satellite x 2D/3D x Batiments 2D = 8 combinaisons.
// Verifie : rendu carte + classe active des boutons (bg-primary) + tuiles OK.
// Usage: node scripts/test-affichage.mjs
// Sorties: demo-visuelle-affichage/*.png, resultats.json, galerie-affichage.html (generee ensuite)
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "demo-visuelle-affichage",
);
mkdirSync(root, { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
});
const page = await context.newPage();

const tiles = { ok: 0, ko: 0, hosts: {} };
page.on("response", (res) => {
  const u = res.url();
  if (
    u.includes("data.geopf.fr") ||
    u.includes("tiles.openfreemap.org") ||
    u.includes("elevation-tiles-prod") ||
    u.includes("server.arcgisonline.com")
  ) {
    const host = new URL(u).hostname;
    tiles.hosts[host] = tiles.hosts[host] || { ok: 0, ko: 0 };
    if (res.status() < 400) {
      tiles.ok++;
      tiles.hosts[host].ok++;
    } else {
      tiles.ko++;
      tiles.hosts[host].ko++;
    }
  }
});

async function btnState(name, exact = false) {
  const cls =
    (await page
      .getByRole("button", exact ? { name, exact: true } : { name })
      .first()
      .getAttribute("class")) || "";
  return cls.includes("bg-primary") ? "ACTIF" : "inactif";
}

async function combo(id, label, actions) {
  for (const a of actions) {
    await page
      .getByRole(
        "button",
        a.exact ? { name: a.name, exact: true } : { name: a.name },
      )
      .click();
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(root, id + ".png") });
  const state = {
    id,
    label,
    Street: await btnState("Street"),
    Satellite: await btnState("Satellite"),
    "2D": await btnState("2D", true),
    "3D": await btnState("3D", true),
    Batiments: await btnState("Bâtiments 2D"),
  };
  console.log(
    id +
      " " +
      label +
      " | Street:" +
      state.Street +
      " Sat:" +
      state.Satellite +
      " 2D:" +
      state["2D"] +
      " 3D:" +
      state["3D"] +
      " Bat:" +
      state.Batiments,
  );
  return state;
}

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

const results = [];
// Etat initial suppose : Street + 2D, RNB off. On force chaque etat.
results.push(
  await combo("01-street-2d", "Street + 2D", [
    { name: "Street" },
    { name: "2D", exact: true },
  ]),
);
results.push(
  await combo("02-satellite-2d", "Satellite + 2D", [{ name: "Satellite" }]),
);
results.push(
  await combo("03-satellite-3d", "Satellite + 3D", [
    { name: "3D", exact: true },
  ]),
);
results.push(await combo("04-street-3d", "Street + 3D", [{ name: "Street" }]));
results.push(
  await combo("05-street-3d-bat", "Street + 3D + Batiments", [
    { name: "Bâtiments 2D" },
  ]),
);
results.push(
  await combo("06-street-2d-bat", "Street + 2D + Batiments", [
    { name: "2D", exact: true },
  ]),
);
results.push(
  await combo("07-satellite-2d-bat", "Satellite + 2D + Batiments", [
    { name: "Satellite" },
  ]),
);
results.push(
  await combo("08-satellite-3d-bat", "Satellite + 3D + Batiments", [
    { name: "3D", exact: true },
  ]),
);
// Retour neutre.
await page.getByRole("button", { name: "Bâtiments 2D" }).click();
await page.getByRole("button", { name: "2D", exact: true }).click();
await page.getByRole("button", { name: "Street" }).click();

writeFileSync(
  join(root, "resultats.json"),
  JSON.stringify({ results, tiles }, null, 2),
);
console.log(
  "TUILES ok=" + tiles.ok + " ko=" + tiles.ko,
  JSON.stringify(tiles.hosts),
);

await browser.close();
console.log("termine:", root);
