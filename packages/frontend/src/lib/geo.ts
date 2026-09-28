import type {
  Waypoint,
  PointOfInterest,
  Obstacle,
  UnitSystem,
} from "@droneroute/shared";
import { formatArea as formatAreaUnit } from "@/lib/units";

export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculate the ideal gimbal pitch angle for a waypoint pointing at a POI.
 * Uses trigonometry: pitch = -atan2(heightDiff, horizontalDist)
 * Returns degrees where 0 = horizon, -90 = straight down, plus the 3D slant distance.
 */
export function calculateIdealGimbalPitch(
  wp: Waypoint,
  poi: PointOfInterest,
): { pitch: number; distance: number } {
  const horizontalDist = haversineDistance(
    wp.latitude,
    wp.longitude,
    poi.latitude,
    poi.longitude,
  );
  const heightDiff = wp.height - poi.height; // positive = drone is above POI
  if (horizontalDist < 0.01) return { pitch: -90, distance: 0 }; // directly above → straight down
  const angleRad = Math.atan2(heightDiff, horizontalDist);
  const pitch = Math.round(-angleRad * (180 / Math.PI));
  const distance = Math.sqrt(horizontalDist ** 2 + heightDiff ** 2);
  return { pitch, distance };
}

// ── Obstacle geometry utilities ──────────────────────────

// Default vertical extent for obstacles without explicit heights (meters
// above ground). Shared by the store, the editor and the map.
export const DEFAULT_OBSTACLE_MIN_HEIGHT_M = 0;
export const DEFAULT_OBSTACLE_MAX_HEIGHT_M = 30;

/**
 * Lower edge of an obstacle in meters (0 when unset).
 */
export function obstacleMinHeightM(obstacle: Obstacle): number {
  const value = obstacle.minHeightM;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_OBSTACLE_MIN_HEIGHT_M;
}

/**
 * Upper edge of an obstacle in meters (30 when unset). Always >= min.
 */
export function obstacleMaxHeightM(obstacle: Obstacle): number {
  const value = obstacle.maxHeightM;
  const min = obstacleMinHeightM(obstacle);
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? value
    : Math.max(min, DEFAULT_OBSTACLE_MAX_HEIGHT_M);
}

/**
 * Ray-casting point-in-polygon test.
 * Returns true if the point [lat, lng] is inside the polygon.
 */
export function pointInPolygon(
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

/**
 * Test if two line segments (p1→p2) and (p3→p4) intersect.
 */
function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d1 = direction(p3, p4, p1);
  const d2 = direction(p3, p4, p2);
  const d3 = direction(p1, p2, p3);
  const d4 = direction(p1, p2, p4);

  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }

  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;

  return false;
}

function direction(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): number {
  return (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
}

function onSegment(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): boolean {
  return (
    Math.min(a[0], b[0]) <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] &&
    c[1] <= Math.max(a[1], b[1])
  );
}

/**
 * Test if a line segment (p1→p2) intersects any edge of a polygon.
 */
export function segmentIntersectsPolygon(
  p1: [number, number],
  p2: [number, number],
  polygon: [number, number][],
): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (segmentsIntersect(p1, p2, polygon[j], polygon[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Obstacle warning describing a flight path conflict.
 */
export interface ObstacleWarning {
  obstacleId: string;
  obstacleName: string;
  waypointIndex: number;
  type: "crosses" | "inside";
}

/**
 * Check all waypoints and flight path segments against all obstacles.
 * A conflict only counts when the flight also overlaps the obstacle
 * vertically ([minHeightM, maxHeightM]) — flying above maxHeightM clears it.
 * Returns a list of warnings for any conflicts found.
 */
export function getObstacleWarnings(
  waypoints: {
    latitude: number;
    longitude: number;
    index: number;
    height?: number;
  }[],
  obstacles: Obstacle[],
): ObstacleWarning[] {
  if (obstacles.length === 0 || waypoints.length === 0) return [];

  const warnings: ObstacleWarning[] = [];
  // Waypoint heights are AGL flight altitudes; obstacles are AGL extents.
  // Missing heights default to 0 (ground level → conflict when overlapping).
  const heightOf = (wp: { height?: number }): number =>
    typeof wp.height === "number" && Number.isFinite(wp.height) ? wp.height : 0;

  for (const obstacle of obstacles) {
    if (obstacle.vertices.length < 3) continue;
    const minH = obstacleMinHeightM(obstacle);
    const maxH = obstacleMaxHeightM(obstacle);

    // Check waypoints inside polygon
    for (const wp of waypoints) {
      const h = heightOf(wp);
      if (
        h >= minH &&
        h <= maxH &&
        pointInPolygon([wp.latitude, wp.longitude], obstacle.vertices)
      ) {
        warnings.push({
          obstacleId: obstacle.id,
          obstacleName: obstacle.name,
          waypointIndex: wp.index,
          type: "inside",
        });
      }
    }

    // Check segments crossing polygon
    for (let i = 0; i < waypoints.length - 1; i++) {
      const wp1 = waypoints[i];
      const wp2 = waypoints[i + 1];
      const segMin = Math.min(heightOf(wp1), heightOf(wp2));
      const segMax = Math.max(heightOf(wp1), heightOf(wp2));
      if (segMin > maxH || segMax < minH) continue;

      const p1: [number, number] = [wp1.latitude, wp1.longitude];
      const p2: [number, number] = [wp2.latitude, wp2.longitude];

      if (segmentIntersectsPolygon(p1, p2, obstacle.vertices)) {
        warnings.push({
          obstacleId: obstacle.id,
          obstacleName: obstacle.name,
          waypointIndex: wp1.index,
          type: "crosses",
        });
      }
    }
  }

  return warnings;
}

/**
 * Compute the approximate area of a polygon on the Earth's surface.
 * Uses the Shoelace formula on projected coordinates (equirectangular).
 * Returns area in square meters.
 */
export function polygonArea(vertices: [number, number][]): number {
  if (vertices.length < 3) return 0;

  const toRad = (deg: number) => (deg * Math.PI) / 180;

  // Use centroid latitude for equirectangular projection scale
  const avgLat = vertices.reduce((s, v) => s + v[0], 0) / vertices.length;
  const cosLat = Math.cos(toRad(avgLat));
  const R = 6371000; // Earth radius in meters

  // Convert to local meters using equirectangular projection
  const refLat = vertices[0][0];
  const refLng = vertices[0][1];
  const projected = vertices.map((v) => [
    (v[1] - refLng) * toRad(1) * R * cosLat, // x (east)
    (v[0] - refLat) * toRad(1) * R, // y (north)
  ]);

  // Shoelace formula
  let area = 0;
  for (let i = 0, j = projected.length - 1; i < projected.length; j = i++) {
    area += projected[j][0] * projected[i][1];
    area -= projected[i][0] * projected[j][1];
  }

  return Math.abs(area / 2);
}

/**
 * Format an area value as a human-readable string.
 */
export function formatArea(
  areaM2: number,
  unitSystem: UnitSystem = "metric",
): string {
  return formatAreaUnit(areaM2, unitSystem);
}

// ── Airspace zone intersection utilities ─────────────────

export interface AirspaceWarning {
  zoneId: string;
  zoneName: string;
  severity: "prohibited" | "restricted";
  type: "crosses" | "inside";
}

/**
 * Extract [lat, lng] polygon rings from a GeoJSON geometry.
 * Handles Polygon and MultiPolygon. GeoJSON coordinates are [lng, lat],
 * so we swap them to [lat, lng] to match our convention.
 */
export function extractPolygons(
  geometry: GeoJSON.Geometry,
): [number, number][][] {
  const rings: [number, number][][] = [];
  if (geometry.type === "Polygon") {
    rings.push(
      geometry.coordinates[0].map(
        ([lng, lat]) => [lat, lng] as [number, number],
      ),
    );
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      rings.push(poly[0].map(([lng, lat]) => [lat, lng] as [number, number]));
    }
  }
  return rings;
}

/**
 * Check all waypoints and flight path segments against airspace zones.
 * Returns deduplicated warnings (one per zone).
 */
export function getAirspaceWarnings(
  waypoints: { latitude: number; longitude: number }[],
  zones: {
    id: string;
    name: string;
    severity: "prohibited" | "restricted";
    geometry: GeoJSON.Geometry;
  }[],
): AirspaceWarning[] {
  if (zones.length === 0 || waypoints.length === 0) return [];

  const warnings = new Map<string, AirspaceWarning>();

  for (const zone of zones) {
    const polygons = extractPolygons(zone.geometry);
    if (polygons.length === 0) continue;

    for (const ring of polygons) {
      if (ring.length < 3) continue;

      // Check if any waypoint is inside
      for (const wp of waypoints) {
        if (pointInPolygon([wp.latitude, wp.longitude], ring)) {
          warnings.set(zone.id, {
            zoneId: zone.id,
            zoneName: zone.name,
            severity: zone.severity,
            type: "inside",
          });
          break;
        }
      }

      if (warnings.has(zone.id)) break;

      // Check if any segment crosses the polygon
      for (let i = 0; i < waypoints.length - 1; i++) {
        const p1: [number, number] = [
          waypoints[i].latitude,
          waypoints[i].longitude,
        ];
        const p2: [number, number] = [
          waypoints[i + 1].latitude,
          waypoints[i + 1].longitude,
        ];
        if (segmentIntersectsPolygon(p1, p2, ring)) {
          warnings.set(zone.id, {
            zoneId: zone.id,
            zoneName: zone.name,
            severity: zone.severity,
            type: "crosses",
          });
          break;
        }
      }

      if (warnings.has(zone.id)) break;
    }
  }

  return Array.from(warnings.values());
}

// ── Statistiques de vol ──────────────────────────────────────

/**
 * Estimate total distance (m) and flight time (s) using per-segment
 * speeds (waypoint speed or global speed when useGlobalSpeed is set).
 */
export function estimateFlightStats(
  waypoints: {
    latitude: number;
    longitude: number;
    speed: number;
    useGlobalSpeed: boolean;
  }[],
  globalSpeed: number,
): { distance: number; time: number } {
  let distance = 0;
  let time = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const segDist = haversineDistance(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude,
    );
    const speed = curr.useGlobalSpeed ? globalSpeed : curr.speed;
    distance += segDist;
    time += speed > 0 ? segDist / speed : 0;
  }
  return { distance, time };
}

// ── RNB 3D extrusion ─────────────────────────────────────────

/** Minimal building input for 3D extrusion (heights precomputed by caller). */
export interface RnbExtrusionInput {
  rnbId: string;
  footprint: Array<{ lat: number; lng: number }>;
  heightM: number;
}

/**
 * Build a GeoJSON collection of closed building footprint polygons carrying
 * per-feature heights for a MapLibre fill-extrusion layer. OpenStreetMap
 * height tags (`render_height`) are sparse in France, so callers pass
 * app-estimated heights (footprint-area heuristic or BD TOPO match)
 * instead of relying on the vector-tile attributes.
 */
export function buildRnbExtrusionCollection(
  buildings: RnbExtrusionInput[],
): GeoJSON.FeatureCollection<GeoJSON.Geometry> {
  return {
    type: "FeatureCollection",
    features: buildings
      .filter((b) => Array.isArray(b.footprint) && b.footprint.length >= 3)
      .map((b) => {
        const ring = b.footprint.map((p): [number, number] => [p.lng, p.lat]);
        ring.push(ring[0]);
        return {
          type: "Feature",
          properties: { id: b.rnbId, height: b.heightM },
          geometry: { type: "Polygon", coordinates: [ring] },
        };
      }),
  } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
}
