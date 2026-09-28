/**
 * Contexte chantier open-source — météo, cadastre, urbanisme, espace aérien.
 *
 * - Météo : Open-Meteo (https://open-meteo.com, CC-BY 4.0, sans clé).
 * - Parcelles : APICarto cadastre (IGN, Licence Ouverte, sans clé).
 * - Urbanisme : APICarto GPU — documents (PLU/PLUi/CC...) + zonage.
 * - Espace aérien : providers existants (DGAC via Géoplateforme, Enaire, NATS).
 */

import { fetchZones } from "./airspace/index.js";

/** Géométrie GeoJSON minimale (sans @types/geojson côté backend). */
type GeoGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: string; coordinates?: unknown };

/** Ray-casting point-in-polygon ([lat, lng]). */
function pointInPolygon(
  point: [number, number],
  polygon: [number, number][],
): boolean {
  const [py, px] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [iy, ix] = polygon[i];
    const [jy, jx] = polygon[j];
    if (iy > py !== jy > py && px < ((jx - ix) * (py - iy)) / (jy - iy) + ix) {
      inside = !inside;
    }
  }
  return inside;
}

export type MeteoSnapshot = {
  windMs: number | null;
  gustsMs: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  label: string;
  time: string | null;
} | null;

/** Nombre max de sommets du polygone parcelle exposé (poids réseau). */
export const PARCEL_POLYGON_MAX_POINTS = 256;

export type ParcelleSnapshot = {
  commune: string | null;
  codeInsee: string | null;
  section: string | null;
  numero: string | null;
  contenanceM2: number | null;
  idu: string | null;
  /** Anneau extérieur [lat, lng], sous-échantillonné si besoin. */
  polygon: Array<[number, number]> | null;
} | null;

export type UrbanismeSnapshot = {
  documentType: string | null;
  partition: string | null;
  zoneLibelle: string | null;
  zoneLibelleLong: string | null;
  zoneType: string | null;
} | null;

export type AirspaceSnapshot = {
  prohibited: number;
  restricted: number;
  names: string[];
} | null;

// ── Météo (Open-Meteo, cache 10 min) ────────────────────────

const meteoCache = new Map<string, { at: number; value: MeteoSnapshot }>();
const METEO_TTL_MS = 1000 * 60 * 10;

function wmoLabel(code: number | null): string {
  if (code === null) return "inconnue";
  if (code === 0) return "dégagé";
  if (code <= 3) return "peu nuageux à couvert";
  if (code <= 48) return "brouillard / givre";
  if (code <= 67) return "pluie";
  if (code <= 77) return "neige";
  if (code <= 82) return "averses";
  if (code >= 95) return "orage";
  return "variable";
}

async function fetchMeteo(lat: number, lon: number): Promise<MeteoSnapshot> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = meteoCache.get(key);
  if (cached && Date.now() - cached.at < METEO_TTL_MS) return cached.value;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_gusts_10m,precipitation,weather_code` +
    `&wind_speed_unit=ms&timezone=auto`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      current?: {
        time?: string;
        wind_speed_10m?: number;
        wind_gusts_10m?: number;
        precipitation?: number;
        weather_code?: number;
      };
    };
    const c = payload?.current;
    if (!c) return null;
    const code = typeof c.weather_code === "number" ? c.weather_code : null;
    const value: MeteoSnapshot = {
      windMs: typeof c.wind_speed_10m === "number" ? c.wind_speed_10m : null,
      gustsMs: typeof c.wind_gusts_10m === "number" ? c.wind_gusts_10m : null,
      precipitationMm:
        typeof c.precipitation === "number" ? c.precipitation : null,
      weatherCode: code,
      label: wmoLabel(code),
      time: typeof c.time === "string" ? c.time : null,
    };
    if (meteoCache.size > 500) meteoCache.clear();
    meteoCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

// ── APICarto helpers ────────────────────────────────────────

type FeatureCollection = {
  features?: Array<{
    properties?: Record<string, unknown>;
    geometry?: GeoGeometry;
  }>;
};

async function queryApicarto(
  path: string,
  lat: number,
  lon: number,
): Promise<FeatureCollection | null> {
  const geom = encodeURIComponent(
    JSON.stringify({ type: "Point", coordinates: [lon, lat] }),
  );
  try {
    const res = await fetch(
      `https://apicarto.ign.fr/api/${path}?geom=${geom}`,
      {
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as FeatureCollection;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Anneau extérieur du polygone, validé et sous-échantillonné pour
 * limiter le poids (utilisé pour contraindre les vols façade).
 */
function parseParcelPolygon(
  fc: FeatureCollection | null,
): Array<[number, number]> | null {
  const geometry = fc?.features?.[0]?.geometry;
  if (!geometry) return null;
  const rings = toLatLngRings(geometry);
  const outer = rings[0]?.filter(
    (pt): pt is [number, number] =>
      Array.isArray(pt) &&
      pt.length >= 2 &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1]),
  );
  if (!outer || outer.length < 3) return null;
  if (outer.length <= PARCEL_POLYGON_MAX_POINTS) return outer;
  const step = outer.length / PARCEL_POLYGON_MAX_POINTS;
  return Array.from(
    { length: PARCEL_POLYGON_MAX_POINTS },
    (_, i) => outer[Math.floor(i * step)] as [number, number],
  );
}

function parseParcelle(fc: FeatureCollection | null): ParcelleSnapshot {
  const p = fc?.features?.[0]?.properties;
  if (!p) return null;
  if (!str(p.numero) && !str(p.section) && !str(p.nom_com)) return null;
  const contenance = num(p.contenance);
  return {
    commune: str(p.nom_com),
    codeInsee: str(p.code_insee),
    section: str(p.section),
    numero: str(p.numero),
    contenanceM2: contenance,
    idu: str(p.idu),
    polygon: parseParcelPolygon(fc),
  };
}

function parseUrbanisme(
  docFc: FeatureCollection | null,
  zoneFc: FeatureCollection | null,
): UrbanismeSnapshot {
  const doc = docFc?.features?.[0]?.properties;
  const zone = zoneFc?.features?.[0]?.properties;
  if (!doc && !zone) return null;
  return {
    documentType: str(doc?.du_type),
    partition: str(doc?.partition) ?? str(zone?.partition),
    zoneLibelle: str(zone?.libelle),
    zoneLibelleLong: str(zone?.libelong),
    zoneType: str(zone?.typezone),
  };
}

// ── Espace aérien : zones contenant le centroïde ────────────

function toLatLngRings(geometry: GeoGeometry): [number, number][][] {
  const rings: [number, number][][] = [];
  if (geometry.type === "Polygon") {
    const coords = (geometry.coordinates ?? []) as number[][][];
    if (coords[0]) {
      rings.push(coords[0].map(([lng, lat]) => [lat, lng] as [number, number]));
    }
  } else if (geometry.type === "MultiPolygon") {
    const coords = (geometry.coordinates ?? []) as number[][][][];
    for (const poly of coords) {
      if (poly[0]) {
        rings.push(poly[0].map(([lng, lat]) => [lat, lng] as [number, number]));
      }
    }
  }
  return rings;
}

// ── Résumé site ─────────────────────────────────────────────

export type SitePoint = { lat: number; lon: number };

export type SiteSummary = {
  centroid: SitePoint;
  meteo: MeteoSnapshot;
  parcelle: ParcelleSnapshot;
  urbanisme: UrbanismeSnapshot;
  airspace: AirspaceSnapshot;
  sources: string[];
};

export async function summarizeSite(points: SitePoint[]): Promise<SiteSummary> {
  const valid = points.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lon) <= 180,
  );
  const centroid: SitePoint =
    valid.length > 0
      ? {
          lat: valid.reduce((s, p) => s + p.lat, 0) / valid.length,
          lon: valid.reduce((s, p) => s + p.lon, 0) / valid.length,
        }
      : { lat: 0, lon: 0 };

  const lats = valid.map((p) => p.lat);
  const lons = valid.map((p) => p.lon);
  const pad = 0.01;
  const bounds = {
    south: Math.min(...lats, centroid.lat) - pad,
    west: Math.min(...lons, centroid.lon) - pad,
    north: Math.max(...lats, centroid.lat) + pad,
    east: Math.max(...lons, centroid.lon) + pad,
  };

  const [meteo, parcelleFc, docFc, zoneFc, zones] = await Promise.all([
    fetchMeteo(centroid.lat, centroid.lon),
    queryApicarto("cadastre/parcelle", centroid.lat, centroid.lon),
    queryApicarto("gpu/document", centroid.lat, centroid.lon),
    queryApicarto("gpu/zone-urba", centroid.lat, centroid.lon),
    valid.length > 0
      ? fetchZones(bounds).catch((): [] => [])
      : Promise.resolve([] as never[]),
  ]);

  // Zones DGAC/Enaire/NATS contenant le centroïde de l'emprise.
  const names: string[] = [];
  let prohibited = 0;
  let restricted = 0;
  for (const zone of zones as {
    name: string;
    severity: "prohibited" | "restricted";
    geometry: GeoGeometry;
  }[]) {
    const rings = toLatLngRings(zone.geometry);
    const inside = rings.some(
      (ring) =>
        ring.length >= 3 && pointInPolygon([centroid.lat, centroid.lon], ring),
    );
    if (!inside) continue;
    if (zone.severity === "prohibited") prohibited += 1;
    else restricted += 1;
    if (zone.name && names.length < 5) names.push(zone.name);
  }

  return {
    centroid,
    meteo,
    parcelle: parseParcelle(parcelleFc),
    urbanisme: parseUrbanisme(docFc, zoneFc),
    airspace:
      zones.length === 0 && valid.length === 0
        ? null
        : { prohibited, restricted, names },
    sources: [
      "Open-Meteo (CC-BY 4.0)",
      "APICarto cadastre + GPU (IGN, Licence Ouverte)",
      "DGAC/Enaire/NATS via Géoplateforme",
    ],
  };
}
