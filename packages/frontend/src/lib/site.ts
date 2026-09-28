import { api } from "@/lib/api";

/** Contexte chantier open-source : météo, cadastre, PLU, DGAC. */
export type SiteSummary = {
  centroid: { lat: number; lon: number };
  meteo: {
    windMs: number | null;
    gustsMs: number | null;
    precipitationMm: number | null;
    weatherCode: number | null;
    label: string;
    time: string | null;
  } | null;
  parcelle: {
    commune: string | null;
    codeInsee: string | null;
    section: string | null;
    numero: string | null;
    contenanceM2: number | null;
    idu: string | null;
    /** Anneau extérieur [lat, lng] (contrainte vols façade). */
    polygon: Array<[number, number]> | null;
  } | null;
  urbanisme: {
    documentType: string | null;
    partition: string | null;
    zoneLibelle: string | null;
    zoneLibelleLong: string | null;
    zoneType: string | null;
  } | null;
  airspace: {
    prohibited: number;
    restricted: number;
    names: string[];
  } | null;
  sources: string[];
};

export type SiteSnapshot = {
  meteo: {
    windMs: number | null;
    gustsMs: number | null;
    precipitationMm: number | null;
    weatherCode: number | null;
    label: string;
  } | null;
  parcelle: {
    commune: string | null;
    section: string | null;
    numero: string | null;
    contenanceM2: number | null;
  } | null;
  urbanisme: {
    documentType: string | null;
    zoneLibelle: string | null;
    zoneLibelleLong: string | null;
  } | null;
  airspace: {
    prohibited: number;
    restricted: number;
    names: string[];
  } | null;
};

export const siteApi = {
  summary: (points: { lat: number; lon: number }[]) =>
    api.post<SiteSummary>("/site/summary", { points }),
};

/** Anneau parcelle valide (≥ 3 sommets finis), sinon null. */
export function normalizeParcelPolygon(
  polygon: unknown,
): Array<[number, number]> | null {
  if (!Array.isArray(polygon)) return null;
  const ring = polygon.filter(
    (pt): pt is [number, number] =>
      Array.isArray(pt) &&
      pt.length >= 2 &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1]),
  );
  return ring.length >= 3 ? ring : null;
}

/** Libellé court "commune section X n°Y", null si rien d'exploitable. */
export function formatParcelLabel(
  parcelle: {
    commune: string | null;
    section: string | null;
    numero: string | null;
  } | null,
): string | null {
  if (!parcelle) return null;
  if (!parcelle.commune && !parcelle.section && !parcelle.numero) return null;
  return (
    `${parcelle.commune ?? ""} section ${parcelle.section ?? "?"} n°${parcelle.numero ?? "?"}`.trim() ||
    null
  );
}

/** Réduit le résumé complet au snapshot envoyé à l'IA. */
export function buildSiteSnapshot(summary: SiteSummary): SiteSnapshot {
  return {
    meteo: summary.meteo
      ? {
          windMs: summary.meteo.windMs,
          gustsMs: summary.meteo.gustsMs,
          precipitationMm: summary.meteo.precipitationMm,
          weatherCode: summary.meteo.weatherCode,
          label: summary.meteo.label,
        }
      : null,
    parcelle: summary.parcelle
      ? {
          commune: summary.parcelle.commune,
          section: summary.parcelle.section,
          numero: summary.parcelle.numero,
          contenanceM2: summary.parcelle.contenanceM2,
        }
      : null,
    urbanisme: summary.urbanisme
      ? {
          documentType: summary.urbanisme.documentType,
          zoneLibelle: summary.urbanisme.zoneLibelle,
          zoneLibelleLong: summary.urbanisme.zoneLibelleLong,
        }
      : null,
    airspace: summary.airspace,
  };
}
