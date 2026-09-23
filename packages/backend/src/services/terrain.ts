/**
 * Terrain open-source chantier — IGN Géoplateforme (Licence Ouverte).
 *
 * - 2D : Plan IGN + BD ORTHO via WMTS (voir frontend MapView).
 * - Altitudes : API de calcul altimétrique RGE ALTI / LiDAR HD.
 *   Docs : https://data.geopf.fr/altimetrie
 *   GET https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json
 *       ?lon=..|..&lat=..|..&resource=ign_rge_alti_wld&delimiter=|&zonly=true
 *
 * Ce service fait office de proxy + cache mémoire (5 req/s max côté IGN).
 */

const ALTIMETRIE_BASE =
  process.env.IGN_ALTIMETRIE_BASE?.trim() ||
  "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest";
const DEFAULT_RESOURCE =
  process.env.IGN_ALTIMETRIE_RESOURCE?.trim() || "ign_rge_alti_wld";

const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const cache = new Map<string, { elevation: number | null; at: number }>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function getCached(lat: number, lon: number): number | null | undefined {
  const entry = cache.get(cacheKey(lat, lon));
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(lat, lon));
    return undefined;
  }
  return entry.elevation;
}

function setCached(lat: number, lon: number, elevation: number | null): void {
  if (cache.size > 5000) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(cacheKey(lat, lon), { elevation, at: Date.now() });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type TerrainPoint = { lat: number; lon: number };
export type TerrainSample = TerrainPoint & { groundM: number | null };

/** Interroge l'API IGN pour un lot de points (max ~50 par requête GET). */
async function fetchBatch(
  points: TerrainPoint[],
  resource: string,
): Promise<(number | null)[]> {
  const lons = points.map((p) => p.lon).join("|");
  const lats = points.map((p) => p.lat).join("|");
  const url =
    `${ALTIMETRIE_BASE}/elevation.json` +
    `?lon=${encodeURIComponent(lons)}&lat=${encodeURIComponent(lats)}` +
    `&resource=${encodeURIComponent(resource)}&delimiter=%7C` +
    `&indent=false&measures=false&zonly=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`IGN altimetrie error (${res.status})`);
  }
  const payload = (await res.json()) as {
    elevations?: (number | { z?: number })[];
  };
  const elevations = payload?.elevations ?? [];
  return points.map((_, i) => {
    const raw = elevations[i];
    if (typeof raw === "number") {
      return raw <= -9999 ? null : Math.round(raw * 100) / 100;
    }
    if (raw && typeof raw === "object" && Number.isFinite(raw.z)) {
      const z = Number(raw.z);
      return z <= -9999 ? null : Math.round(z * 100) / 100;
    }
    return null;
  });
}

/** Altitudes sol RGE ALTI pour une liste de points (avec cache). */
export async function sampleGround(
  points: TerrainPoint[],
  resource: string = DEFAULT_RESOURCE,
): Promise<TerrainSample[]> {
  const results: (TerrainSample | null)[] = Array.from(
    { length: points.length },
    () => null,
  );
  const missing: { point: TerrainPoint; index: number }[] = [];

  points.forEach((p, i) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      results[i] = { ...p, groundM: null };
      return;
    }
    const cached = getCached(p.lat, p.lon);
    if (cached !== undefined) {
      results[i] = { ...p, groundM: cached };
    } else {
      missing.push({ point: p, index: i });
    }
  });

  for (const group of chunk(missing, 50)) {
    try {
      const values = await fetchBatch(
        group.map((g) => g.point),
        resource,
      );
      group.forEach((g, k) => {
        const v = values[k] ?? null;
        setCached(g.point.lat, g.point.lon, v);
        results[g.index] = { ...g.point, groundM: v };
      });
    } catch {
      // En cas d'indisponibilité IGN : ne pas casser la mission.
      group.forEach((g) => {
        results[g.index] = { ...g.point, groundM: null };
      });
    }
  }

  return results as TerrainSample[];
}

export type DrapeWaypoint = TerrainPoint & { heightM: number };

/**
 * Drape un vol à AGL constant au-dessus du MNT IGN.
 * Retourne les hauteurs absolues (sol + AGL) + stats pour l'IA.
 */
export async function drapeToTerrain(
  waypoints: DrapeWaypoint[],
  targetAglM: number,
  resource: string = DEFAULT_RESOURCE,
): Promise<{
  samples: (TerrainSample & {
    targetHeightM: number | null;
    aglBeforeM: number | null;
  })[];
  stats: {
    groundMinM: number | null;
    groundMaxM: number | null;
    reliefM: number | null;
    aglMinBeforeM: number | null;
    aglMaxBeforeM: number | null;
    coveragePct: number;
  };
}> {
  const samples = await sampleGround(waypoints, resource);
  const enriched = samples.map((s, i) => ({
    ...s,
    targetHeightM:
      s.groundM === null
        ? null
        : Math.round((s.groundM + targetAglM) * 100) / 100,
    aglBeforeM:
      s.groundM === null
        ? null
        : Math.round((waypoints[i].heightM - s.groundM) * 100) / 100,
  }));

  const grounds = enriched
    .map((e) => e.groundM)
    .filter((v): v is number => v !== null);
  const agls = enriched
    .map((e) => e.aglBeforeM)
    .filter((v): v is number => v !== null);

  return {
    samples: enriched,
    stats: {
      groundMinM: grounds.length ? Math.min(...grounds) : null,
      groundMaxM: grounds.length ? Math.max(...grounds) : null,
      reliefM:
        grounds.length > 0 ? Math.max(...grounds) - Math.min(...grounds) : null,
      aglMinBeforeM: agls.length ? Math.min(...agls) : null,
      aglMaxBeforeM: agls.length ? Math.max(...agls) : null,
      coveragePct:
        samples.length > 0
          ? Math.round((grounds.length / samples.length) * 100)
          : 0,
    },
  };
}

export function terrainResource(): string {
  return DEFAULT_RESOURCE;
}
