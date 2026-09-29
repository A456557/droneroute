import { Router } from "express";
import { findNearbyStreetPhotos } from "../services/streetlevel.js";

export const streetlevelRoutes = Router();

/**
 * GET /api/streetlevel/nearby?lat=&lon=&radiusM=&limit=
 * Photos de rue Panoramax (IGN, open data, sans clé) proches d'un point.
 * radiusM : 50..500 (défaut 150). limit : 1..8 (défaut 6).
 */
streetlevelRoutes.get("/nearby", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "lat and lon must be numbers" });
    return;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    res.status(400).json({ error: "lat/lon out of range" });
    return;
  }
  const radiusM = Math.min(
    500,
    Math.max(50, Number(req.query.radiusM ?? 150) || 150),
  );
  const limit = Math.min(
    8,
    Math.max(1, Math.round(Number(req.query.limit ?? 6)) || 6),
  );

  try {
    const photos = await findNearbyStreetPhotos(lat, lon, radiusM, limit);
    res.json({
      photos,
      radiusM,
      source: "Panoramax IGN + OSM France (Licence Ouverte, sans clé)",
    });
  } catch {
    res.status(502).json({ error: "Failed to fetch street photos" });
  }
});
