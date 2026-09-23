import { Router } from "express";
import { summarizeSite } from "../services/site.js";

export const siteRoutes = Router();

/**
 * POST /api/site/summary { points: [{lat, lon}] }
 * Contexte chantier open-source : météo (Open-Meteo), parcelle (APICarto
 * cadastre), urbanisme PLU (APICarto GPU) et zones DGAC contenant l'emprise.
 */
siteRoutes.post("/summary", async (req, res) => {
  const points = (req.body as { points?: unknown })?.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > 500) {
    res
      .status(400)
      .json({ error: "points must be a non-empty array (max 500)" });
    return;
  }
  for (const p of points) {
    if (
      !p ||
      typeof p !== "object" ||
      !Number.isFinite((p as { lat?: number }).lat) ||
      !Number.isFinite((p as { lon?: number }).lon)
    ) {
      res.status(400).json({ error: "each point must be { lat, lon }" });
      return;
    }
  }

  try {
    const summary = await summarizeSite(
      points as { lat: number; lon: number }[],
    );
    res.json(summary);
  } catch {
    res.status(502).json({ error: "Failed to build site summary" });
  }
});
