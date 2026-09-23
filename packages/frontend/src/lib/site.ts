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
