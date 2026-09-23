import { Router } from "express";
import {
  drapeToTerrain,
  sampleGround,
  terrainResource,
} from "../services/terrain.js";

export const terrainRoutes = Router();

function isPoint(value: unknown): value is { lat: number; lon: number } {
  if (!value || typeof value !== "object") return false;
  const p = value as { lat?: unknown; lon?: unknown };
  return (
    typeof p.lat === "number" &&
    typeof p.lon === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}

/** GET /api/terrain/elevation?lat=..&lon=.. — altitude sol IGN (RGE ALTI / LiDAR). */
terrainRoutes.get("/elevation", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon must be numbers" });
    return;
  }
  const [sample] = await sampleGround([{ lat, lon }]);
  res.json({
    lat,
    lon,
    groundM: sample?.groundM ?? null,
    resource: terrainResource(),
    source: "IGN Geoplateforme altimetrie (Licence Ouverte)",
  });
});

/** POST /api/terrain/profile { points: [{lat,lon}] } — profil MNT d'un trajet. */
terrainRoutes.post("/profile", async (req, res) => {
  const points = (req.body as { points?: unknown })?.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > 500) {
    res
      .status(400)
      .json({ error: "points must be a non-empty array (max 500)" });
    return;
  }
  if (!points.every(isPoint)) {
    res.status(400).json({ error: "each point must be { lat, lon }" });
    return;
  }
  const samples = await sampleGround(points);
  res.json({
    samples,
    resource: terrainResource(),
    source: "IGN Geoplateforme altimetrie (Licence Ouverte)",
  });
});

/**
 * POST /api/terrain/drape { waypoints: [{lat,lon,heightM}], targetAglM }
 * Calcule le vol à AGL constant adapté au relief (analyse chantier).
 */
terrainRoutes.post("/drape", async (req, res) => {
  const body = (req.body ?? {}) as {
    waypoints?: unknown;
    targetAglM?: unknown;
  };
  if (!Array.isArray(body.waypoints) || body.waypoints.length === 0) {
    res.status(400).json({ error: "waypoints must be a non-empty array" });
    return;
  }
  const targetAglM = Number(body.targetAglM);
  if (!Number.isFinite(targetAglM) || targetAglM < 5 || targetAglM > 500) {
    res.status(400).json({ error: "targetAglM must be between 5 and 500" });
    return;
  }
  const waypoints: { lat: number; lon: number; heightM: number }[] = [];
  for (const wp of body.waypoints) {
    if (
      !wp ||
      typeof wp !== "object" ||
      !Number.isFinite((wp as { lat?: number }).lat) ||
      !Number.isFinite((wp as { lon?: number }).lon) ||
      !Number.isFinite((wp as { heightM?: number }).heightM)
    ) {
      res
        .status(400)
        .json({ error: "each waypoint must be { lat, lon, heightM }" });
      return;
    }
    waypoints.push({
      lat: (wp as { lat: number }).lat,
      lon: (wp as { lon: number }).lon,
      heightM: (wp as { heightM: number }).heightM,
    });
  }

  const result = await drapeToTerrain(waypoints, targetAglM);
  res.json({
    ...result,
    targetAglM,
    resource: terrainResource(),
    source: "IGN Geoplateforme altimetrie (Licence Ouverte)",
  });
});

/** GET /api/terrain/resources — ressource MNT configurée. */
terrainRoutes.get("/resources", (_req, res) => {
  res.json({
    resource: terrainResource(),
    alternatives: ["ign_rge_alti_wld", "ign_bdalti_wld"],
    note: "RGE ALTI 1m/5m par défaut (chantier). LiDAR HD via la même API quand disponible. Liste complète : https://data.geopf.fr/altimetrie/resources",
    source: "IGN Geoplateforme (Licence Ouverte) + data.gouv.fr",
  });
});
