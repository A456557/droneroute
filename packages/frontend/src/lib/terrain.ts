import { api } from "@/lib/api";

export type TerrainSample = {
  lat: number;
  lon: number;
  groundM: number | null;
};

export type DrapeStats = {
  groundMinM: number | null;
  groundMaxM: number | null;
  reliefM: number | null;
  aglMinBeforeM: number | null;
  aglMaxBeforeM: number | null;
  coveragePct: number;
};

export type DrapeResponse = {
  samples: (TerrainSample & {
    targetHeightM: number | null;
    aglBeforeM: number | null;
  })[];
  stats: DrapeStats;
  targetAglM: number;
  resource: string;
  source: string;
};

export type TerrainSnapshot = {
  groundMinM: number | null;
  groundMaxM: number | null;
  reliefM: number | null;
  aglMinM: number | null;
  aglMaxM: number | null;
  coveragePct: number | null;
  source: string;
};

export const terrainApi = {
  profile: (points: { lat: number; lon: number }[]) =>
    api.post<{ samples: TerrainSample[]; resource: string; source: string }>(
      "/terrain/profile",
      { points },
    ),
  drape: (
    waypoints: { lat: number; lon: number; heightM: number }[],
    targetAglM: number,
  ) => api.post<DrapeResponse>("/terrain/drape", { waypoints, targetAglM }),
};

/** Construit le snapshot terrain envoyé à l'IA (vérif trajet vs relief). */
export function buildTerrainSnapshot(
  waypoints: { latitude: number; longitude: number; height: number }[],
  samples: TerrainSample[],
  source = "IGN RGE ALTI",
): TerrainSnapshot | null {
  if (waypoints.length === 0 || samples.length === 0) return null;
  const grounds = samples
    .map((s) => s.groundM)
    .filter((v): v is number => v !== null);
  if (grounds.length === 0) return null;
  const agls: number[] = [];
  samples.forEach((s, i) => {
    const wp = waypoints[i];
    if (s.groundM !== null && wp && Number.isFinite(wp.height)) {
      agls.push(wp.height - s.groundM);
    }
  });
  return {
    groundMinM: Math.min(...grounds),
    groundMaxM: Math.max(...grounds),
    reliefM: Math.max(...grounds) - Math.min(...grounds),
    aglMinM: agls.length ? Math.min(...agls) : null,
    aglMaxM: agls.length ? Math.max(...agls) : null,
    coveragePct: Math.round((grounds.length / samples.length) * 100),
    source,
  };
}
