import type {
  Waypoint,
  PointOfInterest,
  WaypointAction,
} from "@droneroute/shared";
import { DEFAULT_WAYPOINT } from "@droneroute/shared";
import { isPointInsideRingWithMargin } from "./geo";

// ── Helpers ──────────────────────────────────────────────

/** Longueur minimale d'un tracé pencil pour générer une mission (m). */
export const MIN_PENCIL_PATH_LENGTH_M = 10;

/** Move a lat/lng point by a distance (meters) and bearing (degrees, 0=N) */
function destinationPoint(
  lat: number,
  lng: number,
  distanceM: number,
  bearingDeg: number,
): [number, number] {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const brng = toRad(bearingDeg);
  const d = distanceM / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [toDeg(lat2), toDeg(lng2)];
}

/** Bearing from point A to point B in degrees (0=N, 90=E) */
function bearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Haversine distance in meters */
function haversine(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Template Types ───────────────────────────────────────

export type TemplateType = "orbit" | "grid" | "facade" | "pencil";

export interface OrbitParams {
  center: [number, number]; // [lat, lng]
  radiusM: number;
  altitude: number;
  numPoints: number;
  clockwise: boolean;
  createPoi: boolean;
}

export interface GridParams {
  corner1: [number, number]; // [lat, lng]
  corner2: [number, number]; // [lat, lng]
  altitude: number;
  spacingM: number;
  addPhotos: boolean;
  crosshatch: boolean;
  gimbalPitchAngle: number;
  rotationDeg: number; // rotation of the grid in degrees (0-360)
  reverse: boolean; // fly the grid in reverse order
}

export interface FacadeParams {
  point1: [number, number]; // [lat, lng] — one end of wall
  point2: [number, number]; // [lat, lng] — other end of wall
  distanceM: number; // distance from wall
  minAltitude: number;
  maxAltitude: number;
  numRows: number;
  numColumns: number;
  addPhotos: boolean;
  /** Anneau [lat, lng] de la parcelle cadastrale du bâtiment, si connu. */
  parcelPolygon?: [number, number][] | null;
  /** Libellé parcelle pour les rapports (ex. "Paris section AB n°12"). */
  parcelLabel?: string | null;
  /** Marge de sécurité au bord de parcelle (m, défaut 2). */
  parcelMarginM?: number;
  /** Recul mini au mur lors du resserrement (m, défaut 5). */
  parcelMinDistanceM?: number;
}

/** Bilan du maintien des waypoints façade dans la parcelle cadastrale. */
export interface FacadeParcelReport {
  parcelProvided: boolean;
  parcelLabel: string | null;
  totalCount: number;
  insideCount: number;
  adjustedCount: number;
  /** Index (locaux au résultat) restant hors parcelle malgré resserrement. */
  outsideIndexes: number[];
}

/** Marge de sécurité par défaut au bord de parcelle (m). */
export const FACADE_PARCEL_MARGIN_M = 2;
/** Recul mini au mur lors du resserrement dans la parcelle (m). */
export const FACADE_PARCEL_MIN_DISTANCE_M = 5;
/** Pas de resserrement du recul (m). */
const FACADE_PARCEL_CLAMP_STEP_M = 0.5;

export interface PencilParams {
  path: [number, number][]; // raw drawn points [lat, lng]
  numPoints: number; // target waypoint count
  altitude: number;
  speed: number;
  gimbalPitchAngle: number;
  reverse: boolean;
  poiId?: string; // optional POI to face during flight
}

export type TemplateParams =
  | OrbitParams
  | GridParams
  | FacadeParams
  | PencilParams;

export interface TemplateResult {
  waypoints: Omit<Waypoint, "index" | "name">[];
  pois: Omit<PointOfInterest, "id">[];
  /** Bilan parcelle (façade uniquement, null sinon). */
  parcelReport?: FacadeParcelReport | null;
}

// ── Default Params ───────────────────────────────────────

export const DEFAULT_ORBIT_PARAMS: Omit<OrbitParams, "center" | "radiusM"> = {
  altitude: 30,
  numPoints: 12,
  clockwise: true,
  createPoi: true,
};

export const DEFAULT_GRID_PARAMS: Omit<GridParams, "corner1" | "corner2"> = {
  altitude: 80,
  spacingM: 30,
  addPhotos: true,
  crosshatch: false,
  gimbalPitchAngle: -90,
  rotationDeg: 0,
  reverse: false,
};

export const MISSION_PLANNER_3D_GRID_PARAMS: Pick<
  GridParams,
  "spacingM" | "addPhotos" | "crosshatch" | "gimbalPitchAngle"
> = {
  spacingM: 14,
  addPhotos: true,
  crosshatch: true,
  gimbalPitchAngle: -45,
};

export const DEFAULT_FACADE_PARAMS: Omit<FacadeParams, "point1" | "point2"> = {
  distanceM: 20,
  minAltitude: 1,
  maxAltitude: 30,
  numRows: 4,
  numColumns: 8,
  addPhotos: true,
};

/**
 * Altitudes du scan façade d'un bâtiment de hauteur `heightM`.
 * Proportionnelles au bâtiment (l'ancien calcul partait de 8 m fixe avec
 * +8/+12 m de marge, donc un mur de 3 m était scanné entre 8 et 11 m) :
 * départ près du sol, marge de toit pour voir la rive (~25 %, 2 à 8 m).
 * Exemples : 3 m → 1..5 m ; 10 m → 2..13 m ; 30 m → 5..38 m.
 */
export function computeBuildingScanAltitudes(heightM: number): {
  minAltitude: number;
  maxAltitude: number;
} {
  const h = Number.isFinite(heightM) ? Math.max(0.5, heightM) : 10;
  const clampNum = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  const minAltitude = Math.round(clampNum(h * 0.2, 1, 5));
  const roofMarginM = Math.round(clampNum(h * 0.25, 2, 8));
  const maxAltitude = Math.round(
    Math.min(100, Math.max(minAltitude + 1, h + roofMarginM)),
  );
  return { minAltitude, maxAltitude };
}

export const MISSION_PLANNER_VERTICAL_FACADE_PARAMS: Pick<
  FacadeParams,
  | "distanceM"
  | "minAltitude"
  | "maxAltitude"
  | "numRows"
  | "numColumns"
  | "addPhotos"
> = {
  distanceM: 18,
  minAltitude: 1,
  maxAltitude: 36,
  numRows: 5,
  numColumns: 7,
  addPhotos: true,
};

export function computeFacadeAltitudes(
  minAltitude: number,
  maxAltitude: number,
  numRows: number,
): number[] {
  const rows = Math.max(1, Math.round(numRows));
  const [low, high] =
    minAltitude <= maxAltitude
      ? [minAltitude, maxAltitude]
      : [maxAltitude, minAltitude];

  if (rows === 1) {
    return [Math.round(low)];
  }

  return Array.from({ length: rows }, (_, row) => {
    if (row === 0) return Math.round(low);
    if (row === rows - 1) return Math.round(high);
    const fraction = row / (rows - 1);
    return Math.round(low + fraction * (high - low));
  });
}

export const MISSION_PLANNER_DENSE_FACADE_PARAMS: Pick<
  FacadeParams,
  | "distanceM"
  | "minAltitude"
  | "maxAltitude"
  | "numRows"
  | "numColumns"
  | "addPhotos"
> = {
  distanceM: 12,
  minAltitude: 1,
  maxAltitude: 42,
  numRows: 7,
  numColumns: 11,
  addPhotos: true,
};

export const DEFAULT_PENCIL_PARAMS: Omit<PencilParams, "path"> = {
  numPoints: 10,
  altitude: 30,
  speed: 7,
  gimbalPitchAngle: -45,
  reverse: false,
};

// ── Generators ───────────────────────────────────────────

export function generateOrbit(params: OrbitParams): TemplateResult {
  const { center, radiusM, altitude, numPoints, clockwise, createPoi } = params;
  const [cLat, cLng] = center;

  const waypoints: TemplateResult["waypoints"] = [];
  const pois: TemplateResult["pois"] = [];

  // Optionally create a POI at the center
  const poiName = "Orbit center";

  if (createPoi) {
    pois.push({ name: poiName, latitude: cLat, longitude: cLng, height: 0 });
  }

  for (let i = 0; i < numPoints; i++) {
    const fraction = i / numPoints;
    // Start from North (0°), go clockwise or counter-clockwise
    const angleDeg = clockwise ? fraction * 360 : 360 - fraction * 360;
    const [lat, lng] = destinationPoint(cLat, cLng, radiusM, angleDeg);

    // Calculate heading angle toward center
    const headingAngle = bearing(lat, lng, cLat, cLng);
    // Normalize to -180..180 range expected by DJI
    const normalizedHeading =
      headingAngle > 180 ? headingAngle - 360 : headingAngle;

    // Calculate ideal gimbal pitch
    const horizontalDist = radiusM;
    const heightDiff = altitude; // drone is above POI at ground level
    const pitchRad = Math.atan2(heightDiff, horizontalDist);
    const gimbalPitch = Math.round(-pitchRad * (180 / Math.PI));

    waypoints.push({
      ...DEFAULT_WAYPOINT,
      latitude: lat,
      longitude: lng,
      height: altitude,
      speed: 5,
      useGlobalSpeed: false,
      useGlobalHeadingParam: false,
      headingMode: "fixed",
      headingAngle: Math.round(normalizedHeading),
      gimbalPitchAngle: gimbalPitch,
      turnMode: "toPointAndPassWithContinuityCurvature",
      useGlobalTurnParam: false,
      actions: [],
    });
  }

  return { waypoints, pois };
}

export function generateGrid(params: GridParams): TemplateResult {
  const {
    corner1,
    corner2,
    altitude,
    spacingM,
    addPhotos,
    crosshatch,
    gimbalPitchAngle,
    rotationDeg,
    reverse,
  } = params;
  const [lat1, lng1] = corner1;
  const [lat2, lng2] = corner2;

  const waypoints: TemplateResult["waypoints"] = [];

  // Determine bounding box
  const minLat = Math.min(lat1, lat2);
  const maxLat = Math.max(lat1, lat2);
  const minLng = Math.min(lng1, lng2);
  const maxLng = Math.max(lng1, lng2);

  // Center of the bounding box (rotation pivot)
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  // Calculate the width and height of the area in meters
  const widthM = haversine(minLat, minLng, minLat, maxLng);
  const heightM = haversine(minLat, minLng, maxLat, minLng);

  const takePhotoAction: WaypointAction = {
    actionId: 0,
    actionType: "takePhoto",
    params: { payloadPositionIndex: 0 },
  };

  // Rotation helper: rotate a lat/lng point around the center by rotationDeg degrees.
  // Uses equirectangular approximation (accurate enough for small areas).
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const cosCenter = Math.cos((centerLat * Math.PI) / 180);

  function rotatePoint(lat: number, lng: number): [number, number] {
    if (rotationDeg === 0) return [lat, lng];
    // Convert to local offsets in degrees, scaling lng by cos(lat) for equal units
    const dLat = lat - centerLat;
    const dLng = (lng - centerLng) * cosCenter;
    // Rotate
    const rLat = dLat * cosR - dLng * sinR;
    const rLng = dLat * sinR + dLng * cosR;
    // Convert back
    return [centerLat + rLat, centerLng + rLng / cosCenter];
  }

  function appendGridPasses(flyEW: boolean) {
    const crossAxisDist = flyEW ? heightM : widthM;
    const numPasses = Math.max(2, Math.ceil(crossAxisDist / spacingM) + 1);

    for (let pass = 0; pass < numPasses; pass++) {
      const fraction = numPasses <= 1 ? 0 : pass / (numPasses - 1);
      const isReversePass = pass % 2 === 1;

      let wpLat1: number, wpLng1: number, wpLat2: number, wpLng2: number;

      if (flyEW) {
        const lat = minLat + fraction * (maxLat - minLat);
        const startLng = isReversePass ? maxLng : minLng;
        const endLng = isReversePass ? minLng : maxLng;
        wpLat1 = lat;
        wpLng1 = startLng;
        wpLat2 = lat;
        wpLng2 = endLng;
      } else {
        const lng = minLng + fraction * (maxLng - minLng);
        const startLat = isReversePass ? maxLat : minLat;
        const endLat = isReversePass ? minLat : maxLat;
        wpLat1 = startLat;
        wpLng1 = lng;
        wpLat2 = endLat;
        wpLng2 = lng;
      }

      const [rLat1, rLng1] = rotatePoint(wpLat1, wpLng1);
      const [rLat2, rLng2] = rotatePoint(wpLat2, wpLng2);

      waypoints.push({
        ...DEFAULT_WAYPOINT,
        latitude: rLat1,
        longitude: rLng1,
        height: altitude,
        gimbalPitchAngle,
        useGlobalHeadingParam: false,
        headingMode: "followWayline",
        turnMode: "toPointAndStopWithContinuityCurvature",
        useGlobalTurnParam: false,
        actions: addPhotos ? [{ ...takePhotoAction, actionId: 0 }] : [],
      });
      waypoints.push({
        ...DEFAULT_WAYPOINT,
        latitude: rLat2,
        longitude: rLng2,
        height: altitude,
        gimbalPitchAngle,
        useGlobalHeadingParam: false,
        headingMode: "followWayline",
        turnMode: "toPointAndStopWithContinuityCurvature",
        useGlobalTurnParam: false,
        actions: addPhotos ? [{ ...takePhotoAction, actionId: 0 }] : [],
      });
    }
  }

  const primaryFlyEW = widthM >= heightM;
  appendGridPasses(primaryFlyEW);

  if (crosshatch) {
    appendGridPasses(!primaryFlyEW);
  }

  if (reverse) {
    waypoints.reverse();
  }

  return { waypoints, pois: [] };
}

/**
 * Anneau parcelle valide (≥ 3 sommets finis), sinon null.
 * Sans parcelle connue, la génération reste inchangée (compatibilité).
 */
function normalizeParcelRing(
  polygon: [number, number][] | null | undefined,
): [number, number][] | null {
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

export function generateFacade(params: FacadeParams): TemplateResult {
  const {
    point1,
    point2,
    distanceM,
    minAltitude,
    maxAltitude,
    numRows,
    numColumns,
    addPhotos,
    parcelPolygon,
    parcelLabel,
    parcelMarginM,
    parcelMinDistanceM,
  } = params;
  const [lat1, lng1] = point1;
  const [lat2, lng2] = point2;

  const waypoints: TemplateResult["waypoints"] = [];

  // Wall bearing and perpendicular offset direction
  const wallBearing = bearing(lat1, lng1, lat2, lng2);
  // Perpendicular: offset 90° to the right of the wall direction
  const offsetBearing = (wallBearing + 90) % 360;

  const rows = Math.max(1, Math.round(numRows));
  const columns = Math.max(1, Math.round(numColumns));
  const altitudes = computeFacadeAltitudes(minAltitude, maxAltitude, rows);

  // Contrainte parcelle cadastrale : chaque waypoint hors parcelle (avec
  // marge) est resserré vers le mur jusqu'à rentrer, sans descendre sous
  // le recul mini (sécurité). Au maximum dans les limites, jamais au-delà.
  const parcelRing = normalizeParcelRing(parcelPolygon);
  const marginM = parcelMarginM ?? FACADE_PARCEL_MARGIN_M;
  const minDistanceM = Math.max(
    0.5,
    parcelMinDistanceM ?? FACADE_PARCEL_MIN_DISTANCE_M,
  );
  const outsideIndexes: number[] = [];
  let adjustedCount = 0;

  // Generate the scan grid along the wall
  for (let row = 0; row < rows; row++) {
    const alt = altitudes[row];
    const reverse = row % 2 === 1; // zigzag

    for (let col = 0; col < columns; col++) {
      const colIdx = reverse ? columns - 1 - col : col;
      const colFraction = columns <= 1 ? 0 : colIdx / (columns - 1);

      // Point along the wall
      const wallLat = lat1 + colFraction * (lat2 - lat1);
      const wallLng = lng1 + colFraction * (lng2 - lng1);

      // Offset perpendicular to wall, resserré si hors parcelle
      let effectiveDistanceM = Math.max(0, distanceM);
      let wpLat: number;
      let wpLng: number;
      if (parcelRing) {
        [wpLat, wpLng] = destinationPoint(
          wallLat,
          wallLng,
          effectiveDistanceM,
          offsetBearing,
        );
        if (!isPointInsideRingWithMargin(wpLat, wpLng, parcelRing, marginM)) {
          let clamped = effectiveDistanceM;
          while (clamped - FACADE_PARCEL_CLAMP_STEP_M >= minDistanceM - 1e-9) {
            clamped -= FACADE_PARCEL_CLAMP_STEP_M;
            const [candLat, candLng] = destinationPoint(
              wallLat,
              wallLng,
              clamped,
              offsetBearing,
            );
            if (
              isPointInsideRingWithMargin(candLat, candLng, parcelRing, marginM)
            ) {
              wpLat = candLat;
              wpLng = candLng;
              break;
            }
          }
          if (clamped < effectiveDistanceM - 1e-9) {
            // Dernier essai tenu (plancher mini), même si encore dehors.
            [wpLat, wpLng] = destinationPoint(
              wallLat,
              wallLng,
              Math.max(minDistanceM, Math.min(clamped, effectiveDistanceM)),
              offsetBearing,
            );
            effectiveDistanceM = Math.max(
              minDistanceM,
              Math.min(clamped, effectiveDistanceM),
            );
            adjustedCount += 1;
          }
          if (!isPointInsideRingWithMargin(wpLat, wpLng, parcelRing, marginM)) {
            outsideIndexes.push(waypoints.length);
          }
        }
      } else {
        [wpLat, wpLng] = destinationPoint(
          wallLat,
          wallLng,
          effectiveDistanceM,
          offsetBearing,
        );
      }

      // Heading: face the wall (opposite of offset direction)
      const headingToWall = (offsetBearing + 180) % 360;
      const normalizedHeading =
        headingToWall > 180 ? headingToWall - 360 : headingToWall;

      // Gimbal: calculate pitch toward wall point at ground level
      // (recalculé sur le recul effectif après resserrement parcelle)
      const heightDiff = alt; // drone altitude above wall base
      const pitchRad = Math.atan2(
        heightDiff,
        Math.max(0.5, effectiveDistanceM),
      );
      const gimbalPitch = Math.round(-pitchRad * (180 / Math.PI));

      waypoints.push({
        ...DEFAULT_WAYPOINT,
        latitude: wpLat,
        longitude: wpLng,
        height: alt,
        speed: 3,
        useGlobalSpeed: false,
        useGlobalHeadingParam: false,
        headingMode: "fixed",
        headingAngle: Math.round(normalizedHeading),
        gimbalPitchAngle: gimbalPitch,
        turnMode: "toPointAndStopWithContinuityCurvature",
        useGlobalTurnParam: false,
        actions: addPhotos
          ? [
              {
                actionId: 0,
                actionType: "takePhoto",
                params: { payloadPositionIndex: 0 },
              },
            ]
          : [],
      });
    }
  }

  const parcelReport: FacadeParcelReport | null = parcelRing
    ? {
        parcelProvided: true,
        parcelLabel: parcelLabel ?? null,
        totalCount: waypoints.length,
        insideCount: waypoints.length - outsideIndexes.length,
        adjustedCount,
        outsideIndexes,
      }
    : null;

  return { waypoints, pois: [], parcelReport };
}

// ── Pencil (freehand path) ──────────────────────────────

/**
 * Resample a polyline of raw points into exactly `n` equidistant points.
 * Uses cumulative arc-length along the raw path and linear interpolation.
 */
function resamplePath(raw: [number, number][], n: number): [number, number][] {
  if (raw.length === 0) return [];
  if (raw.length === 1 || n <= 1) return [raw[0]];

  // 1. Compute cumulative arc-length distances
  const cumDist: number[] = [0];
  for (let i = 1; i < raw.length; i++) {
    cumDist.push(
      cumDist[i - 1] +
        haversine(raw[i - 1][0], raw[i - 1][1], raw[i][0], raw[i][1]),
    );
  }
  const totalLength = cumDist[cumDist.length - 1];

  if (totalLength === 0) return [raw[0]];

  // 2. Place n points at equal arc-length intervals
  const result: [number, number][] = [];
  let segIdx = 0; // current segment index in the raw path

  for (let k = 0; k < n; k++) {
    const targetDist = (k / (n - 1)) * totalLength;

    // Advance segIdx to find the segment containing targetDist
    while (segIdx < raw.length - 2 && cumDist[segIdx + 1] < targetDist) {
      segIdx++;
    }

    const segLen = cumDist[segIdx + 1] - cumDist[segIdx];
    const t = segLen > 0 ? (targetDist - cumDist[segIdx]) / segLen : 0;

    const lat = raw[segIdx][0] + t * (raw[segIdx + 1][0] - raw[segIdx][0]);
    const lng = raw[segIdx][1] + t * (raw[segIdx + 1][1] - raw[segIdx][1]);
    result.push([lat, lng]);
  }

  return result;
}

/** Total arc-length of a polyline in meters */
export function pathLength(path: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }
  return total;
}

export function generatePencil(params: PencilParams): TemplateResult {
  const { path, numPoints, altitude, speed, gimbalPitchAngle, reverse, poiId } =
    params;

  if (path.length < 2 || numPoints < 2) return { waypoints: [], pois: [] };

  const resampled = resamplePath(path, numPoints);

  const useTowardPoi = !!poiId;

  const waypoints: TemplateResult["waypoints"] = resampled.map(
    ([lat, lng]) => ({
      ...DEFAULT_WAYPOINT,
      latitude: lat,
      longitude: lng,
      height: altitude,
      speed,
      useGlobalSpeed: false,
      useGlobalHeadingParam: false,
      headingMode: useTowardPoi
        ? ("towardPOI" as const)
        : ("followWayline" as const),
      ...(useTowardPoi ? { poiId } : {}),
      gimbalPitchAngle,
      turnMode: "toPointAndPassWithContinuityCurvature" as const,
      useGlobalTurnParam: false,
      actions: [],
    }),
  );

  if (reverse) {
    waypoints.reverse();
  }

  return { waypoints, pois: [] };
}
