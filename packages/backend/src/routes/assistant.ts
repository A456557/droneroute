import { Router } from "express";
import type {
  MissionConfig,
  Obstacle,
  PointOfInterest,
  Waypoint,
} from "@droneroute/shared";
import {
  AssistantAiConfigError,
  generateMissionAssistantResponse,
} from "../services/assistantAi.js";

type MissionTemplateMode = "orbit" | "grid" | "facade" | "pencil" | null;
type MissionProfile = "generic" | "grid-3d" | "facade" | "orbit" | "pencil";

type MissionAssistantRequest = {
  prompt?: unknown;
  missionName?: unknown;
  templateMode?: unknown;
  config?: Partial<MissionConfig> | null;
  waypoints?: unknown;
  pois?: unknown;
  obstacles?: unknown;
};

type SuggestedAction = {
  label: string;
  detail: string;
};

type MissionAssistantResponse = {
  answer: string;
  bullets: string[];
  warnings: string[];
  suggestedActions: SuggestedAction[];
  source: "github-models" | "openai-compatible";
  usedModel: string;
};

type MissionStats = {
  waypointCount: number;
  poiCount: number;
  obstacleCount: number;
  totalDistanceM: number;
  estimatedFlightSeconds: number;
  altitudeMinM: number | null;
  altitudeMaxM: number | null;
  altitudeSpanM: number | null;
  averageSegmentM: number | null;
  longestSegmentM: number | null;
  averageGimbalPitchDeg: number | null;
};

const DEFAULT_AUTO_FLIGHT_SPEED = 7;
const DEFAULT_MAX_BATTERY_MINUTES = 25;

export const assistantRoutes = Router();

function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const radiusM = 6371000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRad(lat2 - lat1);
  const deltaLon = toRad(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(deltaLon / 2) ** 2;

  return radiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isWaypoint(value: unknown): value is Waypoint {
  return (
    !!value &&
    typeof value === "object" &&
    Number.isFinite((value as Waypoint).latitude) &&
    Number.isFinite((value as Waypoint).longitude)
  );
}

function normalizeTemplateMode(value: unknown): MissionTemplateMode {
  return value === "orbit" ||
    value === "grid" ||
    value === "facade" ||
    value === "pencil"
    ? value
    : null;
}

function formatDistance(distanceM: number): string {
  return distanceM >= 1000
    ? `${(distanceM / 1000).toFixed(2)} km`
    : `${Math.round(distanceM)} m`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }

  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

function getMissionStats(
  waypoints: Waypoint[],
  pois: PointOfInterest[],
  obstacles: Obstacle[],
  config?: Partial<MissionConfig> | null,
): MissionStats {
  const altitudes = waypoints
    .map((waypoint) => waypoint.height)
    .filter((height) => Number.isFinite(height));
  const altitudeMinM = altitudes.length > 0 ? Math.min(...altitudes) : null;
  const altitudeMaxM = altitudes.length > 0 ? Math.max(...altitudes) : null;
  const gimbalPitches = waypoints
    .map((waypoint) => waypoint.gimbalPitchAngle)
    .filter((pitch) => Number.isFinite(pitch));

  let totalDistanceM = 0;
  let estimatedFlightSeconds = 0;
  let longestSegmentM = 0;

  for (let index = 1; index < waypoints.length; index += 1) {
    const previous = waypoints[index - 1];
    const current = waypoints[index];
    const segmentDistanceM = haversine(
      previous.latitude,
      previous.longitude,
      current.latitude,
      current.longitude,
    );
    const speed = current.useGlobalSpeed
      ? (config?.autoFlightSpeed ?? DEFAULT_AUTO_FLIGHT_SPEED)
      : current.speed;

    totalDistanceM += segmentDistanceM;
    longestSegmentM = Math.max(longestSegmentM, segmentDistanceM);
    if (Number.isFinite(speed) && speed > 0) {
      estimatedFlightSeconds += segmentDistanceM / speed;
    }
  }

  return {
    waypointCount: waypoints.length,
    poiCount: pois.length,
    obstacleCount: obstacles.length,
    totalDistanceM,
    estimatedFlightSeconds,
    altitudeMinM,
    altitudeMaxM,
    altitudeSpanM:
      altitudeMinM !== null && altitudeMaxM !== null
        ? altitudeMaxM - altitudeMinM
        : null,
    averageGimbalPitchDeg:
      gimbalPitches.length > 0
        ? gimbalPitches.reduce((sum, pitch) => sum + pitch, 0) /
          gimbalPitches.length
        : null,
    averageSegmentM:
      waypoints.length >= 2 ? totalDistanceM / (waypoints.length - 1) : null,
    longestSegmentM: waypoints.length >= 2 ? longestSegmentM : null,
  };
}

function buildFocus(prompt: string) {
  const normalized = prompt.toLowerCase();
  return {
    facade:
      normalized.includes("facade") ||
      normalized.includes("façade") ||
      normalized.includes("mur") ||
      normalized.includes("vertical"),
    mapping3d:
      normalized.includes("building") ||
      normalized.includes("bâtiment") ||
      normalized.includes("reconstruction") ||
      normalized.includes("cartographie") ||
      normalized.includes("grid") ||
      normalized.includes("3d"),
    battery:
      normalized.includes("battery") ||
      normalized.includes("autonomie") ||
      normalized.includes("temps") ||
      normalized.includes("durée"),
    safety:
      normalized.includes("obstacle") ||
      normalized.includes("risque") ||
      normalized.includes("safe") ||
      normalized.includes("sécurité"),
    speed:
      normalized.includes("speed") ||
      normalized.includes("vitesse") ||
      normalized.includes("faster") ||
      normalized.includes("plus vite"),
  };
}

function resolveMissionProfile(
  templateMode: MissionTemplateMode,
  focus: ReturnType<typeof buildFocus>,
): MissionProfile {
  if (templateMode === "facade" || focus.facade) {
    return "facade";
  }

  if (templateMode === "grid" && focus.mapping3d) {
    return "grid-3d";
  }

  if (templateMode === "orbit") {
    return "orbit";
  }

  if (templateMode === "pencil") {
    return "pencil";
  }

  return focus.mapping3d ? "grid-3d" : "generic";
}

function buildBestPracticeBullet(
  profile: MissionProfile,
  stats: MissionStats,
): string {
  switch (profile) {
    case "facade":
      return "Référence Mission Planner: pour une façade, viser une grille très fine, parallèle au mur, idéalement ramenée à une seule ligne utile.";
    case "grid-3d":
      return `Référence Mission Planner: pour une cartographie 3D avec bâtiments, viser environ 80% d’overlap et 80% de sidelap, avec une cross-grid si les façades comptent.${stats.averageGimbalPitchDeg !== null ? ` Gimbal moyen actuel: ${Math.round(stats.averageGimbalPitchDeg)}°.` : ""}`;
    case "orbit":
      return "Bon usage: valider que l’orbite garde un cadrage homogène et une hauteur stable sur l’ensemble du tour.";
    case "pencil":
      return "Bon usage: garder un tracé simple et lisible, puis vérifier manuellement les changements d’altitude et de vitesse.";
    default:
      return "Bon usage: vérifier la cohérence des altitudes, de l’espacement des points et du temps de vol avant export.";
  }
}

function buildSuggestedActions(
  stats: MissionStats,
  maxBatteryMinutes: number,
  focus: ReturnType<typeof buildFocus>,
  profile: MissionProfile,
): SuggestedAction[] {
  const actions: SuggestedAction[] = [];

  if (stats.waypointCount === 0) {
    actions.push({
      label: "Tracer une première route",
      detail:
        "Ajoutez au moins deux waypoints ou appliquez un template pour obtenir une analyse exploitable.",
    });
    return actions;
  }

  if (stats.estimatedFlightSeconds > maxBatteryMinutes * 60) {
    actions.push({
      label: "Découper la mission",
      detail:
        "La durée estimée dépasse la batterie configurée. Séparez le scan en plusieurs passes ou réduisez la densité des waypoints.",
    });
  }

  if (stats.averageSegmentM !== null && stats.averageSegmentM < 4) {
    actions.push({
      label: "Alléger la densité",
      detail:
        "Les segments sont très serrés. Supprimer un waypoint sur deux ou réduire le nombre de lignes/colonnes peut raccourcir la mission sans perdre beaucoup de couverture.",
    });
  }

  if (profile === "facade") {
    actions.push({
      label: "Garder une ligne parallèle au mur",
      detail:
        "La doc Mission Planner conseille une grille façade très fine avec une seule ligne utile, la plus parallèle possible au bâtiment. Le réglage critique est surtout l’écartement latéral, pas l’overlap longitudinal.",
    });
  }

  if (profile === "facade" && (stats.altitudeSpanM ?? 0) < 12) {
    actions.push({
      label: "Étendre la bande altitude",
      detail:
        "Pour une façade ou une reconstruction 3D, augmentez l’écart entre altitude min et max pour couvrir davantage de matière verticale.",
    });
  }

  if (profile === "grid-3d") {
    actions.push({
      label: "Prévoir une cross-grid",
      detail:
        "Pour un site avec bâtiments, la doc Mission Planner recommande un second passage croisé afin de mieux reconstruire les façades et les zones masquées.",
    });
    actions.push({
      label: "Conserver un fort recouvrement",
      detail:
        "Prenez comme base environ 80% d’overlap et 80% de sidelap pour une cartographie 3D robuste, puis allégez seulement si la batterie devient limitante.",
    });
  }

  if (
    profile === "grid-3d" &&
    stats.averageGimbalPitchDeg !== null &&
    stats.averageGimbalPitchDeg <= -70
  ) {
    actions.push({
      label: "Incliner davantage la caméra",
      detail:
        "Avec une caméra trop nadir, les façades manqueront dans la reconstruction. La doc Mission Planner conseille plutôt un angle d’environ 45° par rapport au sol sur les bâtiments.",
    });
  }

  if (stats.obstacleCount > 0 || focus.safety) {
    actions.push({
      label: "Vérifier les dégagements",
      detail:
        "Contrôlez les obstacles et l’écart latéral dans la vue 2D/3D avant export du plan de vol.",
    });
  }

  if (profile === "facade" || profile === "grid-3d") {
    actions.push({
      label: "Contrôler les altitudes terrain",
      detail:
        "Comme dans Mission Planner avec Verify Height, vérifiez que les altitudes restent cohérentes avec le relief et les obstacles avant d’exporter.",
    });
  }

  if (actions.length === 0) {
    actions.push({
      label: "Valider la vue 3D",
      detail:
        "Relisez la trajectoire dans Buildings 3D pour vérifier la cohérence du cadrage, de l’altitude et du sens de passage.",
    });
  }

  return actions.slice(0, 3);
}

function buildWarnings(
  stats: MissionStats,
  maxBatteryMinutes: number,
): string[] {
  const warnings: string[] = [];

  if (stats.waypointCount < 2) {
    warnings.push(
      "Mission incomplète: il faut au moins deux waypoints pour analyser une trajectoire.",
    );
  }

  if (stats.estimatedFlightSeconds > maxBatteryMinutes * 60) {
    warnings.push(
      `Autonomie: ${formatDuration(stats.estimatedFlightSeconds)} estimés pour ${maxBatteryMinutes} min de batterie configurée.`,
    );
  }

  if (stats.longestSegmentM !== null && stats.longestSegmentM > 180) {
    warnings.push(
      `Segment long: un tronçon atteint ${formatDistance(stats.longestSegmentM)}, ce qui peut dégrader le suivi visuel ou la précision de capture.`,
    );
  }

  return warnings;
}

function buildProfileWarnings(
  stats: MissionStats,
  profile: MissionProfile,
): string[] {
  const warnings: string[] = [];

  if (
    profile === "grid-3d" &&
    stats.averageGimbalPitchDeg !== null &&
    stats.averageGimbalPitchDeg <= -70
  ) {
    warnings.push(
      "Cartographie 3D: la caméra semble trop verticale. Pour voir les façades, Mission Planner recommande plutôt un angle proche de 45° et un passage croisé.",
    );
  }

  if (profile === "facade" && (stats.altitudeSpanM ?? 0) < 10) {
    warnings.push(
      "Façade: la plage verticale paraît courte. Une bande altitude trop réduite laisse facilement des trous dans la reconstruction.",
    );
  }

  return warnings;
}

function buildAnswer(
  missionName: string,
  prompt: string,
  stats: MissionStats,
  maxBatteryMinutes: number,
  profile: MissionProfile,
): string {
  if (stats.waypointCount === 0) {
    return `Je n’ai pas encore de trajectoire exploitable pour "${missionName}". Donnez-moi au moins un début de route ou appliquez un template, puis je pourrai résumer le plan de vol et signaler les points faibles.`;
  }

  const focus = buildFocus(prompt);
  const parts = [
    `Mission "${missionName}": ${stats.waypointCount} waypoints sur ${formatDistance(stats.totalDistanceM)} pour environ ${formatDuration(stats.estimatedFlightSeconds)} de vol estimé.`,
  ];

  if (profile === "facade") {
    parts.push(
      `Pour une acquisition façade, la doc Mission Planner recommande une grille très fine et parallèle au mur, idéalement réduite à une seule ligne utile. La bande d’altitude couvre ${stats.altitudeSpanM !== null ? `${Math.round(stats.altitudeSpanM)} m` : "une plage encore non définie"}, donc le réglage clé reste l’écartement latéral et l’amplitude verticale.`,
    );
  } else if (profile === "grid-3d") {
    parts.push(
      `Pour une cartographie 3D avec bâtiments, la doc Mission Planner recommande un fort recouvrement, typiquement autour de 80% en overlap et sidelap, avec une cross-grid et une caméra autour de 45° pour ne pas perdre les façades.`,
    );
  } else if (
    focus.battery ||
    stats.estimatedFlightSeconds > maxBatteryMinutes * 60
  ) {
    parts.push(
      `Le facteur limitant principal est l’autonomie. Tant que la durée reste au-dessus de ${maxBatteryMinutes} min, il vaut mieux réduire la densité ou scinder la mission.`,
    );
  } else if (focus.safety) {
    parts.push(
      `Le point de contrôle principal est la sécurité du passage: espacement entre segments, dégagement obstacle et cohérence des hauteurs.`,
    );
  } else if (focus.speed) {
    parts.push(
      `Si votre priorité est la rapidité, le levier le plus rentable est de simplifier le maillage des waypoints avant d’augmenter la vitesse.`,
    );
  } else {
    parts.push(
      `Le tracé est assez défini pour fournir un retour opérationnel sur couverture, autonomie et lisibilité de la trajectoire.`,
    );
  }

  return parts.join(" ");
}

assistantRoutes.post("/mission", async (req, res) => {
  const {
    prompt,
    missionName,
    templateMode: rawTemplateMode,
    config,
    waypoints: rawWaypoints,
    pois: rawPois,
    obstacles: rawObstacles,
  } = (req.body ?? {}) as MissionAssistantRequest;

  if (typeof prompt !== "string" || prompt.trim().length < 3) {
    res.status(400).json({ error: "prompt must be a non-empty string" });
    return;
  }

  if (!Array.isArray(rawWaypoints) || !rawWaypoints.every(isWaypoint)) {
    res.status(400).json({ error: "waypoints must be a valid waypoint array" });
    return;
  }

  const waypoints = rawWaypoints;
  const pois = Array.isArray(rawPois) ? (rawPois as PointOfInterest[]) : [];
  const obstacles = Array.isArray(rawObstacles)
    ? (rawObstacles as Obstacle[])
    : [];
  const missionLabel =
    typeof missionName === "string" && missionName.trim().length > 0
      ? missionName.trim()
      : "Untitled mission";
  const maxBatteryMinutes = Number.isFinite(config?.maxBatteryMinutes)
    ? Number(config?.maxBatteryMinutes)
    : DEFAULT_MAX_BATTERY_MINUTES;
  const templateMode = normalizeTemplateMode(rawTemplateMode);
  const stats = getMissionStats(waypoints, pois, obstacles, config);
  const focus = buildFocus(prompt);
  const profile = resolveMissionProfile(templateMode, focus);

  const draftResponse = {
    answer: buildAnswer(
      missionLabel,
      prompt.trim(),
      stats,
      maxBatteryMinutes,
      profile,
    ),
    bullets: [
      `${stats.waypointCount} waypoints, ${stats.poiCount} POI, ${stats.obstacleCount} obstacle${stats.obstacleCount > 1 ? "s" : ""}.`,
      `Distance estimée: ${formatDistance(stats.totalDistanceM)}. Temps de vol estimé: ${formatDuration(stats.estimatedFlightSeconds)}.`,
      stats.altitudeMinM !== null && stats.altitudeMaxM !== null
        ? `Plage d’altitude: ${Math.round(stats.altitudeMinM)} m à ${Math.round(stats.altitudeMaxM)} m.${stats.averageGimbalPitchDeg !== null ? ` Gimbal moyen: ${Math.round(stats.averageGimbalPitchDeg)}°.` : ""}`
        : "Plage d’altitude indisponible.",
      buildBestPracticeBullet(profile, stats),
    ],
    warnings: [
      ...buildWarnings(stats, maxBatteryMinutes),
      ...buildProfileWarnings(stats, profile),
    ],
    suggestedActions: buildSuggestedActions(
      stats,
      maxBatteryMinutes,
      focus,
      profile,
    ),
  };

  try {
    const response: MissionAssistantResponse =
      await generateMissionAssistantResponse({
        missionName: missionLabel,
        prompt: prompt.trim(),
        templateMode,
        profile,
        focus,
        stats: {
          waypointCount: stats.waypointCount,
          poiCount: stats.poiCount,
          obstacleCount: stats.obstacleCount,
          totalDistanceM: Math.round(stats.totalDistanceM),
          estimatedFlightSeconds: Math.round(stats.estimatedFlightSeconds),
          altitudeMinM: stats.altitudeMinM,
          altitudeMaxM: stats.altitudeMaxM,
          altitudeSpanM: stats.altitudeSpanM,
          averageSegmentM: stats.averageSegmentM,
          longestSegmentM: stats.longestSegmentM,
          averageGimbalPitchDeg: stats.averageGimbalPitchDeg,
        },
        maxBatteryMinutes,
        draft: draftResponse,
      });

    res.json(response);
  } catch (error) {
    if (error instanceof AssistantAiConfigError) {
      res.status(503).json({ error: error.message });
      return;
    }

    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Mission assistant provider request failed",
    });
  }
});
