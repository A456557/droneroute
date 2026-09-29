import { api } from "@/lib/api";

/** Photo de rue Panoramax (IGN, open data, sans clé). */
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
  /** Instance Panoramax d'origine ("Panoramax IGN" ou "Panoramax OSM France"). */
  source: string;
};

export type StreetPhotosState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; photos: StreetPhoto[] }
  | { status: "error" };

export const streetlevelApi = {
  nearby: (lat: number, lon: number, radiusM = 150, limit = 6) =>
    api.get<{ photos: StreetPhoto[]; radiusM: number; source: string }>(
      `/streetlevel/nearby?lat=${lat}&lon=${lon}&radiusM=${radiusM}&limit=${limit}`,
    ),
};
