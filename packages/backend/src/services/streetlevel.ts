/**
 * Photos de rue open-source (Panoramax IGN, sans clé, Licence Ouverte).
 * Le frontend ne peut pas interroger l'API directement (pas de CORS),
 * ce service proxifie donc la recherche et ne renvoie que le nécessaire :
 * vignette, image SD, lien visionneuse, date, distance, licence.
 * Docs : https://docs.panoramax.fr/api/
 */

export type StreetPhoto = {
  id: string;
  lat: number;
  lon: number;
  thumbUrl: string;
  imageUrl: string;
  viewerUrl: string;
  capturedAt: string | null;
  distanceM: number;
  license: string | null;
  /** Instance Panoramax d'origine ("IGN" ou "OSM France"). */
  source: string;
};

type PanoramaxInstance = {
  name: string;
  api: string;
  viewer: string;
};

// Deux instances open data sans clé au même format STAC : quand l'une
// n'a rien photographié près du point, l'autre couvre souvent la zone.
const PANORAMAX_INSTANCES: PanoramaxInstance[] = [
  {
    name: "IGN",
    api: "https://panoramax.ign.fr/api",
    viewer: "https://panoramax.ign.fr",
  },
  {
    name: "OSM France",
    api: "https://panoramax.openstreetmap.fr/api",
    viewer: "https://panoramax.openstreetmap.fr",
  },
];
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 1000 * 60 * 5;
const CACHE_MAX_ENTRIES = 200;

const cache = new Map<string, { at: number; value: StreetPhoto[] }>();

function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type PanoramaxFeature = {
  id?: unknown;
  geometry?: { coordinates?: unknown };
  properties?: {
    datetime?: unknown;
    license?: unknown;
  };
  assets?: {
    thumb?: { href?: unknown };
    sd?: { href?: unknown };
  };
};

function parsePhoto(
  feature: PanoramaxFeature,
  instance: PanoramaxInstance,
  lat: number,
  lon: number,
): StreetPhoto | null {
  const id = typeof feature.id === "string" ? feature.id : null;
  const coords = feature.geometry?.coordinates;
  const picLon =
    Array.isArray(coords) && typeof coords[0] === "number" ? coords[0] : null;
  const picLat =
    Array.isArray(coords) && typeof coords[1] === "number" ? coords[1] : null;
  const thumbUrl = feature.assets?.thumb?.href;
  const imageUrl = feature.assets?.sd?.href;
  if (!id || picLat === null || picLon === null) return null;
  if (typeof thumbUrl !== "string" || typeof imageUrl !== "string") return null;
  const capturedAt = feature.properties?.datetime;
  const license = feature.properties?.license;
  return {
    id,
    lat: picLat,
    lon: picLon,
    thumbUrl,
    imageUrl,
    viewerUrl: `${instance.viewer}/?focus=pic&pic=${encodeURIComponent(id)}`,
    capturedAt:
      typeof capturedAt === "string" && capturedAt ? capturedAt : null,
    distanceM: Math.round(haversineM(lat, lon, picLat, picLon)),
    license: typeof license === "string" && license ? license : null,
    source: `Panoramax ${instance.name}`,
  };
}

/**
 * Photos Panoramax les plus proches (triées par distance, dans `radiusM`).
 * Retourne [] si indisponible — l'appelant affiche "aucune photo".
 */
export async function findNearbyStreetPhotos(
  lat: number,
  lon: number,
  radiusM: number,
  limit: number,
): Promise<StreetPhoto[]> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusM},${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  // Carré englobant (le tri/filtrage fin se fait sur la distance réelle).
  const dLat = radiusM / 111320;
  const dLon =
    radiusM / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(",");
  const limitParam = Math.min(50, Math.max(limit * 3, limit));

  async function queryInstance(
    instance: PanoramaxInstance,
  ): Promise<StreetPhoto[]> {
    try {
      const res = await fetch(
        `${instance.api}/search?bbox=${bbox}&limit=${limitParam}`,
        {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Accept: "application/geo+json" },
        },
      );
      if (!res.ok) return [];
      const payload = (await res.json()) as {
        features?: PanoramaxFeature[];
      };
      return (payload.features ?? [])
        .map((feature) => parsePhoto(feature, instance, lat, lon))
        .filter((photo): photo is StreetPhoto => photo !== null)
        .filter((photo) => photo.distanceM <= radiusM);
    } catch {
      return [];
    }
  }

  // Les deux instances en parallèle : si l'une est vide ou en panne,
  // l'autre compense (dédupliquées par id, triées par distance).
  const settled = await Promise.allSettled(
    PANORAMAX_INSTANCES.map(queryInstance),
  );
  const seen = new Set<string>();
  const photos = settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((photo) => {
      if (seen.has(photo.id)) return false;
      seen.add(photo.id);
      return true;
    })
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), value: photos });
  return photos;
}
