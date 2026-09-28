import type {
  MissionConfig,
  Obstacle,
  PointOfInterest,
  Waypoint,
} from "@droneroute/shared";
import {
  estimateFlightStats,
  extractPolygons,
  getObstacleWarnings,
  haversineDistance,
  isPointInsideRingWithMargin,
  obstacleMaxHeightM,
  obstacleMinHeightM,
  pointInPolygon,
  segmentIntersectsPolygon,
} from "@/lib/geo";
import {
  FACADE_PARCEL_MARGIN_M,
  MIN_PENCIL_PATH_LENGTH_M,
} from "@/lib/templates";
import type { AirspaceZone } from "@/store/airspaceStore";

// ── Contrôle du parcours ─────────────────────────────────────────
// Moteur de règles déterministes + instantané versionné.
// Réutilise les règles existantes (obstacles, bornes d'altitude de
// l'éditeur, garde-fous d'export/import) au lieu de les dupliquer.
// Aucune marge de sécurité chiffrée n'est inventée ici : ce qui n'est
// pas paramétré est signalé « Non vérifié ».

export type CheckSeverity = "error" | "warning" | "info" | "unverified";
export type FindingStatus = "open" | "ignored";
export type SuggestionStatus = "proposed" | "applied" | "ignored";

export type FindingTarget =
  | { kind: "waypoint"; index: number; lat: number; lng: number }
  | { kind: "segment"; fromIndex: number; lat: number; lng: number }
  | { kind: "area"; lat: number; lng: number; label: string }
  | { kind: "mission" };

/** Position cartographique d'une cible (null pour l'ensemble de la mission). */
export function targetPosition(
  target: FindingTarget,
): { lat: number; lng: number } | null {
  if (target.kind === "mission") return null;
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) {
    return null;
  }
  return { lat: target.lat, lng: target.lng };
}

export interface RouteFinding {
  id: string;
  checkId: string;
  label: string;
  severity: CheckSeverity;
  status: FindingStatus;
  /** Règle ou origine du constat (nom de règle existante, source...). */
  rule: string;
  target: FindingTarget;
  description: string;
  dataSource: { source: string; updatedAt: string | null };
  missing: string[];
  suggestionId?: string;
}

export interface RouteSuggestion {
  id: string;
  findingId: string;
  kind: "remove-waypoint" | "manual";
  label: string;
  justification: string;
  dataUsed: string[];
  /** Trajet complet proposé (aucune mutation, prévisualisation seule). */
  previewWaypoints: Waypoint[] | null;
  /** Index du waypoint concerné (application ciblée). */
  targetWaypointIndex?: number;
  status: SuggestionStatus;
}

export interface RouteReportAiAction {
  label: string;
  detail: string;
  target?: string | null;
  justification?: string | null;
  dataUsed?: string[];
}

export interface RouteReportAi {
  status: "unavailable" | "ok" | "invalid";
  reason?: string;
  explanation?: string;
  actions: RouteReportAiAction[];
  source?: string;
  usedModel?: string | null;
  /** Vrai si le modèle a effectivement analysé la vue cartographique. */
  imageAnalyzed?: boolean;
}

export type RouteGlobalStatus = "blocked" | "review" | "clear";

export interface RouteCheckSummary {
  distanceM: number;
  durationS: number;
  waypointCount: number;
}

export interface RouteCheckReport {
  id: string;
  versionHash: string;
  createdAtISO: string;
  summary: RouteCheckSummary;
  findings: RouteFinding[];
  suggestions: RouteSuggestion[];
  ai: RouteReportAi;
  globalStatus: RouteGlobalStatus;
}

export interface FacadeCheckContext {
  active: boolean;
  templateMode: string | null;
  buildingRnbId: string | null;
  buildingHeightM: number | null;
  heightSource: string | null;
  segmentId: string | null;
  segmentLengthM: number | null;
  distanceM: number | null;
  numRows: number | null;
  numColumns: number | null;
  orbitRadiusM?: number | null;
  orbitNumPoints?: number | null;
  gridSpacingM?: number | null;
  gridAltitudeM?: number | null;
  pencilPathLengthM?: number | null;
  /** Parcelle cadastrale du bâtiment scanné (contrainte vol façade). */
  parcelPolygon?: [number, number][] | null;
  parcelLabel?: string | null;
}

export interface TerrainCheckInput {
  grounds: (number | null)[];
  source: string;
}

export interface AirspaceCheckInput {
  enabled: boolean;
  zones: AirspaceZone[];
}

export interface RouteCheckInput {
  waypoints: Waypoint[];
  pois: PointOfInterest[];
  obstacles: Obstacle[];
  config: MissionConfig;
  templateMode: string | null;
  facade: FacadeCheckContext | null;
  airspace: AirspaceCheckInput;
  /** Relevés MNT alignés par index sur les waypoints (null = sans mesure). */
  terrain: TerrainCheckInput | null;
}

/** Règles bloquantes configurables (aucune politique d'export existante). */
export interface RouteBlockingRules {
  obstacleConflict: boolean;
  prohibitedAirspace: boolean;
  terrainCollision: boolean;
}

export const DEFAULT_BLOCKING_RULES: RouteBlockingRules = {
  obstacleConflict: true,
  prohibitedAirspace: true,
  terrainCollision: true,
};

const NO_UPDATE_DATE = "date de mise à jour non fournie par le fournisseur";

// Formulations interdites : l'analyse ne qualifie jamais un vol.
const BANNED_CLAIM_PATTERNS: RegExp[] = [
  /vol\s+sûr/i,
  /\bsûr\b/i,
  /\bautorisé\b/i,
  /validé par/i,
  /sans danger/i,
  /sans risque/i,
  /\bsafe\b/i,
  /autorisation de vol/i,
];

/** Vrai si le texte présente l'analyse comme une autorisation de vol. */
export function containsBannedClaim(text: string): boolean {
  return BANNED_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

// ── Instantané et version ────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** Empreinte FNV-1a (hex) de l'instantané : tout changement pertinent du
 *  parcours change la version, l'ancien rapport devient périmé. */
export function hashRouteSnapshot(input: RouteCheckInput): string {
  const payload = stableStringify({
    waypoints: input.waypoints,
    pois: input.pois,
    obstacles: input.obstacles,
    config: input.config,
    templateMode: input.templateMode,
    facade: input.facade,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Statistiques de vol (formule partagée lib/geo, vitesses par segment) ───────────

export function routeStats(
  waypoints: Waypoint[],
  globalSpeed: number,
): { distanceM: number; durationS: number } {
  const stats = estimateFlightStats(waypoints, globalSpeed);
  return { distanceM: stats.distance, durationS: Math.round(stats.time) };
}

// ── Moteur ───────────────────────────────────────────────────────

let findingCounter = 0;
let suggestionCounter = 0;

function nextFindingId(): string {
  findingCounter += 1;
  return `finding-${findingCounter}`;
}

function nextSuggestionId(): string {
  suggestionCounter += 1;
  return `suggestion-${suggestionCounter}`;
}

function midpoint(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): { lat: number; lng: number } {
  return {
    lat: (a.latitude + b.latitude) / 2,
    lng: (a.longitude + b.longitude) / 2,
  };
}

function obstacleHasHeights(obstacle: Obstacle): boolean {
  return (
    typeof obstacle.minHeightM === "number" &&
    Number.isFinite(obstacle.minHeightM) &&
    typeof obstacle.maxHeightM === "number" &&
    Number.isFinite(obstacle.maxHeightM)
  );
}

export function runRouteChecks(input: RouteCheckInput): {
  findings: RouteFinding[];
  suggestions: RouteSuggestion[];
  summary: RouteCheckSummary;
} {
  const findings: RouteFinding[] = [];
  const suggestions: RouteSuggestion[] = [];
  const { waypoints, pois, obstacles, config } = input;

  const pushFinding = (
    finding: Omit<RouteFinding, "id" | "status">,
  ): RouteFinding => {
    const full: RouteFinding = {
      ...finding,
      id: nextFindingId(),
      status: "open",
    };
    findings.push(full);
    return full;
  };

  const pushSuggestion = (
    suggestion: Omit<RouteSuggestion, "id" | "status">,
  ): RouteSuggestion => {
    const full: RouteSuggestion = {
      ...suggestion,
      id: nextSuggestionId(),
      status: "proposed",
    };
    suggestions.push(full);
    return full;
  };

  // R-01 — validité des waypoints (mêmes bornes que l'éditeur : 1..500 m).
  const poiIds = new Set(pois.map((poi) => poi.id));
  for (const wp of waypoints) {
    const problems: string[] = [];
    if (
      !Number.isFinite(wp.latitude) ||
      wp.latitude < -90 ||
      wp.latitude > 90 ||
      !Number.isFinite(wp.longitude) ||
      wp.longitude < -180 ||
      wp.longitude > 180
    ) {
      problems.push("coordonnées hors limites ou invalides");
    }
    if (!Number.isFinite(wp.height) || wp.height < 1 || wp.height > 500) {
      problems.push("altitude hors limites (1 à 500 m)");
    }
    if (!Number.isFinite(wp.speed) || wp.speed <= 0) {
      problems.push("vitesse invalide");
    }
    if (
      wp.headingMode === "towardPOI" &&
      (!wp.poiId || !poiIds.has(wp.poiId))
    ) {
      problems.push("POI de cap introuvable");
    }
    if (problems.length > 0) {
      pushFinding({
        checkId: "R-01",
        label: `Waypoint ${wp.index + 1} invalide`,
        severity: "error",
        rule: "Validité des waypoints (bornes de l'éditeur, import KMZ)",
        target: {
          kind: "waypoint",
          index: wp.index,
          lat: wp.latitude,
          lng: wp.longitude,
        },
        description: `Waypoint ${wp.index + 1} : ${problems.join(", ")}. Corrigez les valeurs avant l'export.`,
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: [],
      });
    }
  }

  // R-03 — continuité des segments (doublons exacts au centimètre près).
  for (let i = 0; i < waypoints.length - 1; i++) {
    const current = waypoints[i];
    const next = waypoints[i + 1];
    const gapM = haversineDistance(
      current.latitude,
      current.longitude,
      next.latitude,
      next.longitude,
    );
    if (gapM < 0.01) {
      const mid = midpoint(current, next);
      const finding = pushFinding({
        checkId: "R-03",
        label: `Segment nul entre waypoints ${current.index + 1} et ${next.index + 1}`,
        severity: "error",
        rule: "Continuité des segments (points confondus)",
        target: {
          kind: "segment",
          fromIndex: current.index,
          lat: mid.lat,
          lng: mid.lng,
        },
        description: `Les waypoints ${current.index + 1} et ${next.index + 1} sont au même endroit : le segment est vide.`,
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: [],
      });
      const preview = waypoints.filter((wp) => wp.index !== next.index);
      const suggestion = pushSuggestion({
        findingId: finding.id,
        kind: "remove-waypoint",
        targetWaypointIndex: next.index,
        label: `Supprimer le waypoint ${next.index + 1} dupliqué`,
        justification:
          "Le segment vide n'apporte aucune couverture et peut faire hésiter le drone. La suppression ne change pas la géométrie du trajet.",
        dataUsed: ["Positions des waypoints"],
        previewWaypoints: preview,
      });
      finding.suggestionId = suggestion.id;
    }
  }

  // R-04 — obstacles (réutilise les avertissements existants, 2D + volume).
  const obstacleWarnings = getObstacleWarnings(waypoints, obstacles);
  for (const warning of obstacleWarnings) {
    const obstacle = obstacles.find((o) => o.id === warning.obstacleId);
    const minH = obstacle ? obstacleMinHeightM(obstacle) : 0;
    const maxH = obstacle ? obstacleMaxHeightM(obstacle) : 30;
    const volumeNote =
      obstacle && obstacleHasHeights(obstacle)
        ? `volume ${Math.round(minH)} à ${Math.round(maxH)} m`
        : "emprise 2D (hauteurs non renseignées)";
    if (warning.type === "inside") {
      const wp = waypoints.find((w) => w.index === warning.waypointIndex);
      pushFinding({
        checkId: "R-04",
        label: `Waypoint dans l'obstacle « ${warning.obstacleName} »`,
        severity: "error",
        rule: "Intersection des obstacles connus (moteur existant)",
        target: {
          kind: "waypoint",
          index: warning.waypointIndex,
          lat: wp?.latitude ?? 0,
          lng: wp?.longitude ?? 0,
        },
        description: `Le waypoint ${warning.waypointIndex + 1} est dans ${volumeNote} de l'obstacle « ${warning.obstacleName} ». Déplacez-le ou ajustez sa hauteur manuellement.`,
        dataSource: { source: "Obstacles de la mission", updatedAt: null },
        missing:
          obstacle && !obstacleHasHeights(obstacle)
            ? ["Hauteurs mini/maxi de l'obstacle"]
            : [],
      });
    } else {
      const from = waypoints.find((w) => w.index === warning.waypointIndex);
      const to = waypoints[waypoints.indexOf(from as Waypoint) + 1];
      const mid =
        from && to
          ? midpoint(from, to)
          : { lat: from?.latitude ?? 0, lng: from?.longitude ?? 0 };
      pushFinding({
        checkId: "R-04",
        label: `Segment en conflit avec « ${warning.obstacleName} »`,
        severity: "error",
        rule: "Intersection des obstacles connus (moteur existant)",
        target: {
          kind: "segment",
          fromIndex: warning.waypointIndex,
          lat: mid.lat,
          lng: mid.lng,
        },
        description: `Le segment après le waypoint ${warning.waypointIndex + 1} traverse ${volumeNote} de l'obstacle « ${warning.obstacleName} ». Relevez le passage au-dessus ou contournez l'obstacle.`,
        dataSource: { source: "Obstacles de la mission", updatedAt: null },
        missing:
          obstacle && !obstacleHasHeights(obstacle)
            ? ["Hauteurs mini/maxi de l'obstacle"]
            : [],
      });
    }
  }
  // Passage franc au-dessus : conclusion favorable fondée (deux hauteurs connues).
  for (const obstacle of obstacles) {
    if (!obstacleHasHeights(obstacle)) continue;
    const maxH = obstacleMaxHeightM(obstacle);
    const conflicts = obstacleWarnings.some(
      (w) => w.obstacleId === obstacle.id,
    );
    if (conflicts) continue;
    const minClearance = Math.min(...waypoints.map((wp) => wp.height - maxH));
    if (
      Number.isFinite(minClearance) &&
      minClearance > 0 &&
      waypoints.length > 0
    ) {
      const lowest = waypoints.reduce((a, b) => (a.height <= b.height ? a : b));
      pushFinding({
        checkId: "R-04",
        label: `Passage au-dessus de « ${obstacle.name} »`,
        severity: "info",
        rule: "Intersection des obstacles connus (moteur existant)",
        target: {
          kind: "waypoint",
          index: lowest.index,
          lat: lowest.latitude,
          lng: lowest.longitude,
        },
        description: `Le point le plus bas (${Math.round(lowest.height)} m) passe au-dessus du haut de l'obstacle (${Math.round(maxH)} m). Écart minimal de ${Math.round(minClearance)} m sur les données renseignées.`,
        dataSource: { source: "Obstacles de la mission", updatedAt: null },
        missing: [],
      });
    }
  }

  // R-05 — hauteur du bâtiment RNB (jamais de conclusion favorable sans source).
  const facade = input.facade;
  if (facade?.active && facade.buildingRnbId) {
    if (facade.buildingHeightM == null) {
      pushFinding({
        checkId: "R-05",
        label: "Hauteur du bâtiment inconnue",
        severity: "warning",
        rule: "Rapprochement RNB (identifiant uniquement, jamais une hauteur)",
        target: { kind: "mission" },
        description:
          "Aucune hauteur exploitable pour ce bâtiment (source, unité et référentiel requis). Impossible de conclure qu'un passage au-dessus est possible.",
        dataSource: { source: "RNB + BD TOPO", updatedAt: null },
        missing: ["Hauteur du bâtiment (BD TOPO ou relevé)"],
      });
    } else {
      pushFinding({
        checkId: "R-05",
        label: `Hauteur du bâtiment : ${Math.round(facade.buildingHeightM)} m`,
        severity: "info",
        rule: "Rapprochement RNB (identifiant uniquement, jamais une hauteur)",
        target: { kind: "mission" },
        description: `Hauteur de ${Math.round(facade.buildingHeightM)} m issue de ${facade.heightSource ?? "source inconnue"}.`,
        dataSource: {
          source: facade.heightSource ?? "Source inconnue",
          updatedAt: null,
        },
        missing: [],
      });
    }
  }

  // R-06 — cohérence du scan de façade (structurelle ; le numérique fin
  // reste non vérifié faute de seuils configurés).
  if (facade?.active && input.templateMode === "facade") {
    const paramsOk =
      Number.isFinite(facade.distanceM ?? NaN) &&
      Number.isFinite(facade.numRows ?? NaN) &&
      (facade.numRows ?? 0) >= 1 &&
      Number.isFinite(facade.numColumns ?? NaN) &&
      (facade.numColumns ?? 0) >= 1;
    if (!facade.buildingRnbId) {
      pushFinding({
        checkId: "R-06",
        label: "Scan de façade sans bâtiment de référence",
        severity: "warning",
        rule: "Cohérence du scan de façade",
        target: { kind: "mission" },
        description:
          "Un scan de façade est actif mais aucun bâtiment n'est sélectionné : impossible de vérifier l'alignement du scan.",
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: ["Bâtiment sélectionné"],
      });
    }
    if (!facade.segmentId) {
      pushFinding({
        checkId: "R-06",
        label: "Aucun segment de façade sélectionné",
        severity: "warning",
        rule: "Cohérence du scan de façade",
        target: { kind: "mission" },
        description:
          "Sélectionnez le segment de mur à scanner pour verrouiller la géométrie du plan de vol.",
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: ["Segment de façade"],
      });
    }
    if (!paramsOk) {
      pushFinding({
        checkId: "R-06",
        label: "Paramètres de façade incomplets",
        severity: "error",
        rule: "Cohérence du scan de façade",
        target: { kind: "mission" },
        description:
          "Écartement, lignes ou colonnes manquants ou invalides : le scan ne peut pas être généré tel quel.",
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: ["Paramètres de façade valides"],
      });
    }
    pushFinding({
      checkId: "R-06",
      label: "Écartement du scan non vérifié",
      severity: "unverified",
      rule: "Cohérence du scan de façade",
      target: { kind: "mission" },
      description:
        "L'écartement prévu n'est pas confronté à la hauteur du bâtiment : aucun seuil configuré, contrôle non paramétré.",
      dataSource: { source: "Mission en cours", updatedAt: null },
      missing: ["Seuils d'écartement configurés"],
    });
  }

  // R-07 — restrictions aériennes (2D uniquement : altitudes AMSL des
  // zones incompatibles avec les hauteurs relatives au décollage).
  if (!input.airspace.enabled) {
    pushFinding({
      checkId: "R-07",
      label: "Restrictions aériennes non vérifiées",
      severity: "unverified",
      rule: "Conflits de restrictions (ENAIRE, DGAC, NATS)",
      target: { kind: "mission" },
      description:
        "La couche espace aérien est désactivée : activez-la pour contrôler les zones interdites et restreintes.",
      dataSource: { source: "Couche espace aérien", updatedAt: null },
      missing: ["Zones aériennes chargées"],
    });
  } else if (input.airspace.zones.length === 0) {
    pushFinding({
      checkId: "R-07",
      label: "Restrictions aériennes non vérifiées",
      severity: "unverified",
      rule: "Conflits de restrictions (ENAIRE, DGAC, NATS)",
      target: { kind: "mission" },
      description:
        "Aucune zone chargée sur l'emprise du parcours : déplacez la carte ou vérifiez la connexion aux fournisseurs.",
      dataSource: { source: "Couche espace aérien", updatedAt: null },
      missing: ["Zones aériennes chargées"],
    });
  } else {
    for (const zone of input.airspace.zones) {
      const rings = extractPolygons(zone.geometry).filter(
        (ring) => ring.length >= 3,
      );
      if (rings.length === 0) continue;
      const insideAny = (lat: number, lng: number): boolean =>
        rings.some((ring) => pointInPolygon([lat, lng], ring));
      for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (!insideAny(wp.latitude, wp.longitude)) continue;
        const prohibited = zone.severity === "prohibited";
        pushFinding({
          checkId: "R-07",
          label: `Waypoint ${wp.index + 1} en zone ${prohibited ? "interdite" : "restreinte"} (${zone.name})`,
          severity: prohibited ? "error" : "warning",
          rule: "Conflits de restrictions (ENAIRE, DGAC, NATS)",
          target: {
            kind: "waypoint",
            index: wp.index,
            lat: wp.latitude,
            lng: wp.longitude,
          },
          description: `Le waypoint ${wp.index + 1} est dans l'emprise 2D de « ${zone.name} » (${zone.category ?? zone.severity}, source ${zone.source}). Contrôle sans filtrage altimétrique : référentiels incompatibles (AMSL contre hauteur relative au décollage).`,
          dataSource: { source: zone.source, updatedAt: NO_UPDATE_DATE },
          missing: ["Référentiel altimétrique commun"],
        });
      }
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        if (
          insideAny(a.latitude, a.longitude) ||
          insideAny(b.latitude, b.longitude)
        ) {
          continue; // déjà signalé comme waypoint
        }
        const crosses = rings.some((ring) =>
          segmentIntersectsPolygon(
            [a.latitude, a.longitude],
            [b.latitude, b.longitude],
            ring,
          ),
        );
        if (!crosses) continue;
        const mid = midpoint(a, b);
        const prohibited = zone.severity === "prohibited";
        pushFinding({
          checkId: "R-07",
          label: `Segment en zone ${prohibited ? "interdite" : "restreinte"} (${zone.name})`,
          severity: prohibited ? "error" : "warning",
          rule: "Conflits de restrictions (ENAIRE, DGAC, NATS)",
          target: {
            kind: "segment",
            fromIndex: a.index,
            lat: mid.lat,
            lng: mid.lng,
          },
          description: `Le segment après le waypoint ${a.index + 1} traverse l'emprise 2D de « ${zone.name} » (source ${zone.source}).`,
          dataSource: { source: zone.source, updatedAt: NO_UPDATE_DATE },
          missing: ["Référentiel altimétrique commun"],
        });
      }
    }
  }

  // R-08 — dégagement relief (décollage = WP0 ; collision certaine sous 0,
  // sans seuil inventé).
  if (!input.terrain) {
    pushFinding({
      checkId: "R-08",
      label: "Dégagement relief non vérifié",
      severity: "unverified",
      rule: "Profil MNT et dégagement",
      target: { kind: "mission" },
      description:
        "Profil de terrain indisponible (MNT IGN injoignable ou hors couverture) : le dégagement par rapport au relief n'est pas contrôlé.",
      dataSource: { source: "MNT IGN", updatedAt: NO_UPDATE_DATE },
      missing: ["Profil de terrain MNT"],
    });
  } else {
    const grounds = input.terrain.grounds;
    const measured = grounds.filter(
      (g): g is number => typeof g === "number" && Number.isFinite(g),
    );
    if (measured.length === 0 || !Number.isFinite(grounds[0] ?? NaN)) {
      pushFinding({
        checkId: "R-08",
        label: "Dégagement relief non vérifié",
        severity: "unverified",
        rule: "Profil MNT et dégagement",
        target: { kind: "mission" },
        description:
          "Sol inconnu au point de décollage ou sur le trajet : impossible de calculer le dégagement.",
        dataSource: { source: input.terrain.source, updatedAt: NO_UPDATE_DATE },
        missing: ["Altitude du sol (MNT)"],
      });
    } else {
      const takeoffGround = grounds[0] as number;
      let minClearance = Infinity;
      let minIndex = 0;
      waypoints.forEach((wp, i) => {
        const g = grounds[i];
        if (typeof g !== "number" || !Number.isFinite(g)) return;
        const clearance = wp.height + takeoffGround - g;
        if (clearance < minClearance) {
          minClearance = clearance;
          minIndex = i;
        }
      });
      if (!Number.isFinite(minClearance)) {
        pushFinding({
          checkId: "R-08",
          label: "Dégagement relief non vérifié",
          severity: "unverified",
          rule: "Profil MNT et dégagement",
          target: { kind: "mission" },
          description:
            "Couverture MNT partielle : aucun point mesuré ne permet le calcul.",
          dataSource: {
            source: input.terrain.source,
            updatedAt: NO_UPDATE_DATE,
          },
          missing: ["Altitude du sol (MNT)"],
        });
      } else if (minClearance < 0) {
        const wp = waypoints[minIndex];
        pushFinding({
          checkId: "R-08",
          label: `Trajectoire sous le relief (waypoint ${wp.index + 1})`,
          severity: "error",
          rule: "Profil MNT et dégagement",
          target: {
            kind: "waypoint",
            index: wp.index,
            lat: wp.latitude,
            lng: wp.longitude,
          },
          description: `Le waypoint ${wp.index + 1} passe ${Math.abs(Math.round(minClearance))} m sous le sol estimé (${input.terrain.source}). Relevez-le manuellement.`,
          dataSource: {
            source: input.terrain.source,
            updatedAt: NO_UPDATE_DATE,
          },
          missing: [],
        });
      } else {
        const wp = waypoints[minIndex];
        pushFinding({
          checkId: "R-08",
          label: `Dégagement minimal de ${Math.round(minClearance)} m`,
          severity: "info",
          rule: "Profil MNT et dégagement",
          target: {
            kind: "waypoint",
            index: wp.index,
            lat: wp.latitude,
            lng: wp.longitude,
          },
          description: `Point le plus bas relatif au relief au waypoint ${wp.index + 1} (${Math.round(minClearance)} m, source ${input.terrain.source}). Marge non jugée : aucun seuil configuré.`,
          dataSource: {
            source: input.terrain.source,
            updatedAt: NO_UPDATE_DATE,
          },
          missing: ["Seuil de dégagement configuré"],
        });
      }
    }
  }

  // R-09 — paramètres du modèle (structurels uniquement).
  const mode = input.templateMode;
  if (mode === "orbit") {
    const r = facade?.orbitRadiusM;
    const n = facade?.orbitNumPoints;
    if (
      !(typeof r === "number" && r > 0) ||
      !(typeof n === "number" && n >= 3)
    ) {
      pushFinding({
        checkId: "R-09",
        label: "Paramètres d'orbite incomplets",
        severity: "error",
        rule: "Paramètres du modèle de mission",
        target: { kind: "mission" },
        description:
          "Rayon ou nombre de points manquant : une orbite demande un rayon positif et au moins 3 points.",
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: ["Paramètres d'orbite valides"],
      });
    }
  } else if (mode === "grid") {
    const spacing = facade?.gridSpacingM;
    const altitude = facade?.gridAltitudeM;
    if (
      !(typeof spacing === "number" && spacing > 0) ||
      !Number.isFinite(altitude ?? NaN)
    ) {
      pushFinding({
        checkId: "R-09",
        label: "Paramètres de grille incomplets",
        severity: "error",
        rule: "Paramètres du modèle de mission",
        target: { kind: "mission" },
        description:
          "Espacement ou altitude manquant : la grille ne peut pas être générée telle quelle.",
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: ["Paramètres de grille valides"],
      });
    }
  } else if (mode === "pencil") {
    const lengthM = facade?.pencilPathLengthM;
    if (!(typeof lengthM === "number") || lengthM < MIN_PENCIL_PATH_LENGTH_M) {
      pushFinding({
        checkId: "R-09",
        label: "Tracé pencil trop court",
        severity: "error",
        rule: `Longueur minimale de ${MIN_PENCIL_PATH_LENGTH_M} m (règle existante)`,
        target: { kind: "mission" },
        description: `Le tracé fait ${lengthM != null && Number.isFinite(lengthM) ? `${Math.round(lengthM)} m` : "une longueur inconnue"} pour un minimum de ${MIN_PENCIL_PATH_LENGTH_M} m.`,
        dataSource: { source: "Mission en cours", updatedAt: null },
        missing: [],
      });
    }
  }

  // R-10 — distance et autonomie (formule partagée lib/geo).
  const globalSpeed = Number.isFinite(config?.autoFlightSpeed)
    ? Number(config.autoFlightSpeed)
    : 7;
  const { distanceM, durationS } = routeStats(waypoints, globalSpeed);
  const maxBatteryMinutes = Number.isFinite(config?.maxBatteryMinutes)
    ? Number(config.maxBatteryMinutes)
    : NaN;
  if (!Number.isFinite(maxBatteryMinutes)) {
    pushFinding({
      checkId: "R-10",
      label: "Autonomie non vérifiée",
      severity: "unverified",
      rule: "Distance, durée et autonomie",
      target: { kind: "mission" },
      description: `Trajet de ${Math.round(distanceM)} m pour ${formatDurationFr(durationS)}, mais aucune autonomie configurée : impossible de conclure.`,
      dataSource: { source: "Mission en cours", updatedAt: null },
      missing: ["Autonomie batterie configurée"],
    });
  } else if (durationS > maxBatteryMinutes * 60) {
    pushFinding({
      checkId: "R-10",
      label: `Autonomie dépassée (${formatDurationFr(durationS)} pour ${maxBatteryMinutes} min)`,
      severity: "warning",
      rule: "Distance, durée et autonomie",
      target: { kind: "mission" },
      description: `Durée estimée de ${formatDurationFr(durationS)} supérieure aux ${maxBatteryMinutes} min configurées, pour ${Math.round(distanceM)} m. Réduisez la densité ou scindez la mission.`,
      dataSource: { source: "Mission en cours", updatedAt: null },
      missing: [],
    });
  } else {
    pushFinding({
      checkId: "R-10",
      label: `Autonomie suffisante (${formatDurationFr(durationS)} pour ${maxBatteryMinutes} min)`,
      severity: "info",
      rule: "Distance, durée et autonomie",
      target: { kind: "mission" },
      description: `Trajet de ${Math.round(distanceM)} m, durée estimée de ${formatDurationFr(durationS)}. Estimation indicative (vitesses nominales, sans vent ni réserve).`,
      dataSource: { source: "Mission en cours", updatedAt: null },
      missing: [],
    });
  }

  // R-11 — maintien du scan de façade dans la parcelle cadastrale du
  // bâtiment (marge de sécurité incluse ; jamais bloquant : warning).
  const parcelRing = Array.isArray(facade?.parcelPolygon)
    ? facade.parcelPolygon.filter(
        (pt): pt is [number, number] =>
          Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
      )
    : [];
  if (facade?.active && parcelRing.length >= 3 && waypoints.length > 0) {
    const outside = waypoints.filter(
      (wp) =>
        !isPointInsideRingWithMargin(
          wp.latitude,
          wp.longitude,
          parcelRing,
          FACADE_PARCEL_MARGIN_M,
        ),
    );
    const parcelName = facade.parcelLabel ?? "la parcelle cadastrale";
    if (outside.length === 0) {
      pushFinding({
        checkId: "R-11",
        label: "Vol façade dans la parcelle",
        severity: "info",
        rule: "Maintien dans la parcelle cadastrale",
        target: { kind: "mission" },
        description: `Les ${waypoints.length} waypoints restent dans ${parcelName} (marge ${FACADE_PARCEL_MARGIN_M} m).`,
        dataSource: { source: "PCI (APICarto cadastre)", updatedAt: null },
        missing: [],
      });
    } else {
      const listed = outside
        .slice(0, 8)
        .map((wp) => `n°${wp.index + 1}`)
        .join(", ");
      pushFinding({
        checkId: "R-11",
        label: `${outside.length} waypoint${outside.length > 1 ? "s" : ""} hors parcelle`,
        severity: "warning",
        rule: "Maintien dans la parcelle cadastrale",
        target: { kind: "mission" },
        description: `${outside.length} waypoint${outside.length > 1 ? "s" : ""} (${listed}${outside.length > 8 ? ", …" : ""}) sortent de ${parcelName} malgré le resserrement au recul mini : survol de parcelle voisine possible, à vérifier avant export.`,
        dataSource: { source: "PCI (APICarto cadastre)", updatedAt: null },
        missing: [],
      });
    }
  }

  return {
    findings,
    suggestions,
    summary: {
      distanceM: Math.round(distanceM),
      durationS,
      waypointCount: waypoints.length,
    },
  };
}

export function formatDurationFr(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}
