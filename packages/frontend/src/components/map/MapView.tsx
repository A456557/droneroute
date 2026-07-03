import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AltitudeMode,
  APIProvider,
  GestureHandling,
  Map,
  Map3D,
  MapMode,
  Marker3D,
  Pin,
  RenderingType,
  useMap,
} from "@vis.gl/react-google-maps";
import { toast } from "sonner";
import { useMissionStore } from "@/store/missionStore";
import { useConfigStore } from "@/store/configStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAirspaceStore } from "@/store/airspaceStore";
import { getObstacleWarnings, pointInPolygon } from "@/lib/geo";
import {
  type BdnbBuildingEnrichment,
  buildingApi,
  type BdTopoMatchedBuilding,
  type DetectBuildingResponse,
  type FacadeCopilotObjective,
  type DetectedBuilding,
  type FacadeCopilotRecommendation,
  type RnbBuilding,
} from "@/lib/api";
import {
  DEFAULT_FACADE_PARAMS,
  DEFAULT_GRID_PARAMS,
  DEFAULT_ORBIT_PARAMS,
  MISSION_PLANNER_DENSE_FACADE_PARAMS,
  MISSION_PLANNER_3D_GRID_PARAMS,
  MISSION_PLANNER_VERTICAL_FACADE_PARAMS,
  DEFAULT_PENCIL_PARAMS,
  generateFacade,
  generateGrid,
  generateOrbit,
  generatePencil,
  pathLength,
  type FacadeParams,
  type GridParams,
  type OrbitParams,
  type PencilParams,
  type TemplateResult,
} from "@/lib/templates";
import { MapToolbar } from "./MapToolbar";
import { TemplateConfigPanel } from "./TemplateConfigPanel";
import {
  InfoWindowOverlay,
  MarkerOverlay,
  PolygonOverlay,
  PolylineOverlay,
} from "./googleMapOverlays";
import { RnbBuildingsLayer } from "./RnbBuildingsLayer";

type DraggablePanelProps = {
  className: string;
  defaultPosition: { x: number; y: number };
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
};

function DraggablePanel({
  className,
  defaultPosition,
  title,
  onClose,
  children,
}: DraggablePanelProps) {
  const [position, setPosition] = useState(defaultPosition);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    setPosition(defaultPosition);
  }, [defaultPosition.x, defaultPosition.y]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
      };

      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [position.x, position.y],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      setPosition({
        x: dragState.originX + event.clientX - dragState.startX,
        y: dragState.originY + event.clientY - dragState.startY,
      });
      event.stopPropagation();
    },
    [],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      event.stopPropagation();
    },
    [],
  );

  return (
    <div
      className={`${className} absolute`}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur-sm">
        <div
          className="flex cursor-grab items-center justify-between gap-3 rounded-t-lg border-b border-border/70 px-3 py-2 active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </div>
          {onClose ? (
            <button
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
              type="button"
            >
              Fermer
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

type LatLng = google.maps.LatLngLiteral;
type TemplateMode = "orbit" | "grid" | "facade" | "pencil" | null;
type FacadeSegmentOption = {
  id: string;
  label: string;
  start: LatLng;
  end: LatLng;
  lengthM: number;
  distanceToHintM: number;
  angleDeltaDeg: number;
  score: number;
};

type FacadeVariantOption = {
  id: string;
  label: string;
  params: FacadeParams;
  score: number;
  detail: string;
};

type Buildings3DView = {
  center: google.maps.LatLngAltitudeLiteral;
  range: number;
  heading: number;
  tilt: number;
  title: string;
  subtitle: string;
};

type MainMapViewport = {
  center: LatLng;
  zoom: number;
  heading: number;
  tilt: number;
};

type Buildings3DMarker = {
  id: string;
  position: google.maps.LatLngLiteral;
  glyph: string;
  label: string;
  background: string;
  borderColor: string;
  glyphColor: string;
  scale?: number;
};

type Buildings3DScanRoute = {
  title: string;
  path: google.maps.LatLngAltitudeLiteral[];
  waypointMarkers: Buildings3DMarker[];
};

type ReconstructionPresetOption = {
  id: string;
  label: string;
  detail: string;
  description: string;
  templateType: Exclude<TemplateMode, "pencil" | null>;
  orbitParams?: OrbitParams;
  gridParams?: GridParams;
  facadeParams?: FacadeParams;
};

type BuildingScanMode = "reconstruction-3d" | "facade-scan";

type BuildingScanVariantOption = {
  id: string;
  label: string;
  detail: string;
  description: string;
};

type BuildingScanPreview = {
  mission: TemplateResult;
  label: string;
};

type StreetViewContext = {
  status: "available" | "unavailable" | "unknown";
  panoramaLocation: LatLng | null;
  distanceM: number | null;
  headingFromBuildingDeg: number | null;
  label: string;
};

type ReconstructedBuildingShell = {
  roofCoordinates: google.maps.LatLngAltitudeLiteral[];
  ridgeCoordinates: google.maps.LatLngAltitudeLiteral[] | null;
  estimatedHeightM: number;
  wallHeightM: number;
  roofPeakHeightM: number;
  confidencePercent: number;
  roofStyleLabel: string;
  heightSourceLabel: string;
  streetViewLabel: string;
  sourceSummary: string;
  note: string;
};

type SelectedRnbBuilding = {
  building: RnbBuilding;
  position: google.maps.LatLngLiteral;
};

type BuildingDetectionCacheEntry = {
  center: LatLng;
  radiusM: number;
  response: DetectBuildingResponse;
  cachedAt: number;
};

const MIN_PENCIL_PATH_LENGTH_M = 10;
const ROADMAP_TYPE = "roadmap" as google.maps.MapTypeId;
const HYBRID_TYPE = "hybrid" as google.maps.MapTypeId;
const RECONSTRUCTION_DEMO_QUERY = "facade-reconstruction";
const BUILDING_DETECTION_CACHE_KEY = "droneroute-building-detection-cache-v1";
const BUILDING_DETECTION_CACHE_MAX_ENTRIES = 12;
const BUILDING_DETECTION_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 6;
const RECONSTRUCTION_DEMO_PRESET = {
  searchLabel: "Siurana, Tarragona",
  facadeParams: {
    point1: [41.25841, 0.93216] as [number, number],
    point2: [41.25831, 0.93245] as [number, number],
    ...DEFAULT_FACADE_PARAMS,
  },
  objective: "reconstruction" as FacadeCopilotObjective,
};
const RECONSTRUCTION_DEMO_BUILDING: DetectedBuilding = {
  id: "demo-siurana-building",
  footprint: [
    { lat: 41.258415, lng: 0.9322 },
    { lat: 41.258431, lng: 0.932314 },
    { lat: 41.258335, lng: 0.932332 },
    { lat: 41.258319, lng: 0.932218 },
    { lat: 41.258415, lng: 0.9322 },
  ],
  centroid: { lat: 41.258375, lng: 0.932266 },
  confidence: 0.88,
  estimatedHeightM: 18,
  heightSource: "osm-height",
  levels: 2,
  roofShape: "gabled",
  roofDirectionDeg: 102,
  roofHeightM: 4,
  source: "demo-fixture",
  distanceToQueryM: 8,
};

function loadBuildingDetectionCache(): BuildingDetectionCacheEntry[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(BUILDING_DETECTION_CACHE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    return parsed.filter((entry): entry is BuildingDetectionCacheEntry => {
      return (
        entry &&
        Number.isFinite(entry?.center?.lat) &&
        Number.isFinite(entry?.center?.lng) &&
        Number.isFinite(entry?.radiusM) &&
        Number.isFinite(entry?.cachedAt) &&
        now - entry.cachedAt < BUILDING_DETECTION_CACHE_MAX_AGE_MS &&
        entry.response?.building &&
        Array.isArray(entry.response?.candidates)
      );
    });
  } catch {
    return [];
  }
}

function saveBuildingDetectionCache(entries: BuildingDetectionCacheEntry[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      BUILDING_DETECTION_CACHE_KEY,
      JSON.stringify(entries),
    );
  } catch {
    // Ignore storage quota or serialization errors.
  }
}

function rememberBuildingDetection(
  cacheRef: { current: BuildingDetectionCacheEntry[] },
  center: LatLng,
  radiusM: number,
  response: DetectBuildingResponse,
) {
  const now = Date.now();
  const nextEntries = [
    {
      center,
      radiusM,
      response,
      cachedAt: now,
    },
    ...cacheRef.current.filter(
      (entry) =>
        now - entry.cachedAt < BUILDING_DETECTION_CACHE_MAX_AGE_MS &&
        haversine(entry.center.lat, entry.center.lng, center.lat, center.lng) >
          Math.max(35, radiusM * 0.45),
    ),
  ].slice(0, BUILDING_DETECTION_CACHE_MAX_ENTRIES);

  cacheRef.current = nextEntries;
  saveBuildingDetectionCache(nextEntries);
}

function toDetectedBuildingFromRnb(
  building: RnbBuilding,
  bdTopoBuilding?: BdTopoMatchedBuilding | null,
): DetectedBuilding {
  return {
    id: `rnb-${building.rnbId}`,
    footprint: building.footprint,
    centroid: building.point,
    confidence: 0.98,
    estimatedHeightM: bdTopoBuilding?.heightM ?? null,
    heightSource: bdTopoBuilding?.heightM != null ? "osm-height" : null,
    levels: bdTopoBuilding?.floorCount ?? null,
    roofShape: null,
    roofDirectionDeg: null,
    roofHeightM: null,
    source: "rnb",
    distanceToQueryM: 0,
  };
}

function estimatedBuildingHeightM(
  building: RnbBuilding,
  bdTopoBuilding?: BdTopoMatchedBuilding | null,
): number {
  if (bdTopoBuilding?.heightM != null) {
    return clamp(bdTopoBuilding.heightM, 12, 120);
  }

  const footprintAreaM2 = footprintAreaMeters(building.footprint);
  const heuristicHeightM = clamp(
    12 + Math.sqrt(Math.max(footprintAreaM2, 1)) * 0.32,
    11,
    48,
  );

  return clamp(heuristicHeightM, 12, 120);
}

function buildBuildingScanFacadeParams(
  segment: FacadeSegmentOption,
  heightM: number,
  density: "standard" | "dense",
): FacadeParams {
  const distanceM =
    density === "dense"
      ? Math.round(clamp(Math.max(10, heightM * 0.42), 10, 20))
      : Math.round(clamp(Math.max(12, heightM * 0.55), 12, 28));
  const numRows =
    density === "dense"
      ? Math.round(clamp(Math.ceil(heightM / 4.5), 6, 10))
      : Math.round(clamp(Math.ceil(heightM / 6), 4, 8));
  const numColumns =
    density === "dense"
      ? Math.round(clamp(Math.ceil(segment.lengthM / 3.6), 8, 16))
      : Math.round(clamp(Math.ceil(segment.lengthM / 5), 5, 12));

  return {
    ...DEFAULT_FACADE_PARAMS,
    ...(density === "dense"
      ? MISSION_PLANNER_DENSE_FACADE_PARAMS
      : MISSION_PLANNER_VERTICAL_FACADE_PARAMS),
    point1: [segment.start.lat, segment.start.lng],
    point2: [segment.end.lat, segment.end.lng],
    distanceM,
    minAltitude: 8,
    maxAltitude: Math.round(
      clamp(heightM + (density === "dense" ? 12 : 8), 24, 100),
    ),
    numRows,
    numColumns,
    addPhotos: true,
  };
}

function appendTemplateResultWithOffset(
  target: TemplateResult,
  result: TemplateResult,
  namePrefix: string,
) {
  const currentWaypointCount = target.waypoints.length;
  target.waypoints.push(
    ...result.waypoints.map((waypoint, index) => ({
      ...waypoint,
      name: `${namePrefix} ${currentWaypointCount + index + 1}`,
    })),
  );
  target.pois.push(...result.pois);
}

function generateFacadeMissionForAllSegments(args: {
  segments: FacadeSegmentOption[];
  heightM: number;
  density: "standard" | "dense";
}): TemplateResult {
  const mission: TemplateResult = { waypoints: [], pois: [] };

  for (const segment of args.segments) {
    const params = buildBuildingScanFacadeParams(
      segment,
      args.heightM,
      args.density,
    );
    const result = generateFacade(params);
    appendTemplateResultWithOffset(
      mission,
      result,
      `${segment.label} waypoint`,
    );
  }

  return mission;
}

function generateBuildingReconstructionMission(args: {
  building: DetectedBuilding;
  selectedSegment: FacadeSegmentOption | null;
}): TemplateResult | null {
  const presets = buildReconstructionPresets(
    args.building,
    args.selectedSegment,
  );

  const preferredOrder = ["building-grid-3d", "roof-grid", "oblique-orbit"];
  const selectedPresets = preferredOrder
    .map((id) => presets.find((preset) => preset.id === id))
    .filter((preset): preset is ReconstructionPresetOption => preset != null);

  if (selectedPresets.length === 0) {
    return null;
  }

  const mission: TemplateResult = { waypoints: [], pois: [] };

  for (const preset of selectedPresets) {
    if (preset.templateType === "grid" && preset.gridParams) {
      appendTemplateResultWithOffset(
        mission,
        generateGrid(preset.gridParams),
        `${preset.label} waypoint`,
      );
      continue;
    }

    if (preset.templateType === "orbit" && preset.orbitParams) {
      appendTemplateResultWithOffset(
        mission,
        generateOrbit(preset.orbitParams),
        `${preset.label} waypoint`,
      );
    }
  }

  return mission;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildRnbInfoWindowContent(args: {
  building: RnbBuilding;
  bdTopoBuilding: BdTopoMatchedBuilding | null;
  threeDMarkers: Buildings3DMarker[];
  approximateBuildingShell: ReconstructedBuildingShell | null;
  loading: boolean;
}): React.ReactNode {
  const {
    building,
    bdTopoBuilding,
    threeDMarkers,
    approximateBuildingShell,
    loading,
  } = args;
  const rnbStatus = building.status ?? "unknown";
  const bdTopoHeight =
    bdTopoBuilding?.heightM != null
      ? `${Math.round(bdTopoBuilding.heightM)} m`
      : "n/a";
  const bdTopoFloors =
    bdTopoBuilding?.floorCount != null
      ? String(Math.round(bdTopoBuilding.floorCount))
      : "n/a";
  const usageLine = [bdTopoBuilding?.usage1, bdTopoBuilding?.usage2]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" / ");
  const footprintForSegments = bdTopoBuilding?.footprint ?? building.footprint;
  const footprintMetrics = footprintMetricsSummary(footprintForSegments);
  const segmentLengthsHtml =
    buildFootprintSegmentLengthsHtml(footprintForSegments);
  const segmentRows = segmentLengthsHtml
    .split("</div>")
    .filter((row) => row.trim().length > 0)
    .map((row, index) => (
      <div key={`segment-row-${index}`}>{row.replace(/<[^>]+>/g, "")}</div>
    ));

  return (
    <div className="min-w-[220px] max-w-[300px] bg-white text-[12px] leading-[1.45] text-black">
      <div className="font-bold text-black">Bâtiment RNB</div>
      <div className="mt-2 font-bold text-black">Dimensions</div>
      <div>
        <strong>Hauteur:</strong> {bdTopoHeight}
      </div>
      <div>
        <strong>Périmètre:</strong> {footprintMetrics.perimeterLabel}
      </div>
      <div>
        <strong>Longueur max:</strong> {footprintMetrics.lengthLabel}
      </div>
      <div>
        <strong>Largeur max:</strong> {footprintMetrics.widthLabel}
      </div>
      <div>
        <strong>Surface approx.:</strong> {footprintMetrics.areaLabel}
      </div>
      {segmentRows.length > 0 ? (
        <>
          <div className="mt-2 font-bold text-black">Segments du polygone</div>
          {segmentRows}
        </>
      ) : null}
      <div className="mt-2 font-bold text-black">RNB</div>
      <div>
        <strong>RNB:</strong> {building.rnbId}
      </div>
      <div>
        <strong>Statut:</strong> {rnbStatus}
      </div>
      <div>
        <strong>Adresses liées:</strong> {building.addressCount}
      </div>
      <div>
        <strong>Actif:</strong> {building.isActive ? "oui" : "non"}
      </div>
      <div className="mt-2 font-bold text-black">BD TOPO</div>
      {loading ? <div className="text-black">Chargement BD TOPO…</div> : null}
      <div>
        <strong>Cleabs:</strong>{" "}
        {bdTopoBuilding?.cleabs ?? building.bdTopoId ?? "n/a"}
      </div>
      <div>
        <strong>Nature:</strong> {bdTopoBuilding?.nature ?? "n/a"}
      </div>
      <div>
        <strong>Usage:</strong> {usageLine || "n/a"}
      </div>
      <div>
        <strong>Étages:</strong> {bdTopoFloors}
      </div>
      <div>
        <strong>Origine:</strong> {bdTopoBuilding?.origin ?? "n/a"}
      </div>
      {threeDMarkers.length > 0 ? (
        <>
          <div className="mt-2 font-bold text-black">3D mission markers</div>
          {threeDMarkers.map((marker) => (
            <div key={marker.id}>
              <strong>{marker.glyph}:</strong> {marker.label}
            </div>
          ))}
        </>
      ) : null}
      {approximateBuildingShell ? (
        <>
          <div className="mt-2 font-bold text-black">
            Hybrid 3D building estimate
          </div>
          <div>
            {approximateBuildingShell.roofStyleLabel} at about{" "}
            {Math.round(approximateBuildingShell.estimatedHeightM)}m.
          </div>
          <div className="text-black">
            {approximateBuildingShell.heightSourceLabel} /{" "}
            {approximateBuildingShell.streetViewLabel}
          </div>
          <div>
            <strong>Credibility:</strong>{" "}
            {approximateBuildingShell.confidencePercent}%
          </div>
        </>
      ) : null}
    </div>
  );
}

function buildFootprintSegmentLengthsHtml(footprint: LatLng[]): string {
  if (footprint.length < 2) {
    return "";
  }

  const hasClosingPoint =
    footprint.length >= 2 &&
    footprint[0].lat === footprint[footprint.length - 1].lat &&
    footprint[0].lng === footprint[footprint.length - 1].lng;
  const segmentCount = hasClosingPoint
    ? footprint.length - 1
    : footprint.length;

  if (segmentCount < 2) {
    return "";
  }

  const rows: string[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = footprint[index];
    const end = footprint[(index + 1) % segmentCount];
    const lengthM = haversine(start.lat, start.lng, end.lat, end.lng);
    rows.push(
      `<div><strong>S${index + 1}:</strong> ${escapeHtml(lengthM.toFixed(1))} m</div>`,
    );
  }

  return rows.join("");
}

function footprintMetricsSummary(footprint: LatLng[]): {
  perimeterLabel: string;
  lengthLabel: string;
  widthLabel: string;
  areaLabel: string;
} {
  const normalized = normalizeFootprint(footprint);
  if (normalized.length < 3) {
    return {
      perimeterLabel: "n/a",
      lengthLabel: "n/a",
      widthLabel: "n/a",
      areaLabel: "n/a",
    };
  }

  let perimeterM = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length];
    perimeterM += haversine(current.lat, current.lng, next.lat, next.lng);
  }

  const centroid = footprintCentroid(normalized);
  const localPoints = normalized.map((point) => toLocalXY(centroid, point));
  const primaryBearing = longestEdgeBearing(normalized) ?? 0;
  const projected = localPoints.map((point) =>
    projectOnBearingAxis(point, primaryBearing),
  );
  const uValues = projected.map((point) => point.u);
  const vValues = projected.map((point) => point.v);
  const maxLengthM = Math.max(...uValues) - Math.min(...uValues);
  const maxWidthM = Math.max(...vValues) - Math.min(...vValues);
  const areaM2 = footprintAreaMeters(normalized);

  return {
    perimeterLabel: `${perimeterM.toFixed(1)} m`,
    lengthLabel: `${Math.max(maxLengthM, maxWidthM).toFixed(1)} m`,
    widthLabel: `${Math.min(maxLengthM, maxWidthM).toFixed(1)} m`,
    areaLabel: `${Math.round(areaM2)} m²`,
  };
}

function findCachedBuildingDetection(
  cacheRef: { current: BuildingDetectionCacheEntry[] },
  center: LatLng,
  radiusM: number,
): DetectBuildingResponse | null {
  const now = Date.now();
  const freshEntries = cacheRef.current.filter(
    (entry) => now - entry.cachedAt < BUILDING_DETECTION_CACHE_MAX_AGE_MS,
  );

  if (freshEntries.length !== cacheRef.current.length) {
    cacheRef.current = freshEntries;
    saveBuildingDetectionCache(freshEntries);
  }

  const maxDistanceM = Math.max(90, radiusM * 1.8);
  const bestMatch = freshEntries
    .map((entry) => ({
      entry,
      distanceM: haversine(
        entry.center.lat,
        entry.center.lng,
        center.lat,
        center.lng,
      ),
    }))
    .filter((candidate) => candidate.distanceM <= maxDistanceM)
    .sort((left, right) => left.distanceM - right.distanceM)[0];

  return bestMatch?.entry.response ?? null;
}

function dashedIcon(strokeColor: string): google.maps.IconSequence[] {
  return [
    {
      icon: {
        path: "M 0,-1 0,1",
        strokeOpacity: 1,
        strokeWeight: 2,
        strokeColor,
        scale: 2,
      },
      offset: "0",
      repeat: "12px",
    },
  ];
}

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

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

function offsetMeters(
  lat: number,
  lng: number,
  northM: number,
  eastM: number,
): [number, number] {
  const dLat = northM / 111320;
  const dLng = eastM / (111320 * Math.cos(deg2rad(lat)));
  return [lat + dLat, lng + dLng];
}

function bearingTo(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const phi1 = deg2rad(lat1);
  const phi2 = deg2rad(lat2);
  const deltaLambda = deg2rad(lng2 - lng1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function toLatLng(latitude: number, longitude: number): LatLng {
  return { lat: latitude, lng: longitude };
}

function resolveWaypointHeading(
  waypoint: typeof useMissionStore.getState extends () => infer T
    ? T extends { waypoints: infer W }
      ? W extends Array<infer Item>
        ? Item
        : never
      : never
    : never,
  pois: ReturnType<typeof useMissionStore.getState>["pois"],
): number {
  if (waypoint.headingMode === "towardPOI" && waypoint.poiId) {
    const poi = pois.find((item) => item.id === waypoint.poiId);
    if (poi) {
      return bearingTo(
        waypoint.latitude,
        waypoint.longitude,
        poi.latitude,
        poi.longitude,
      );
    }
  }
  return waypoint.headingAngle ?? 0;
}

function hasExplicitHeading(
  waypoint: typeof useMissionStore.getState extends () => infer T
    ? T extends { waypoints: infer W }
      ? W extends Array<infer Item>
        ? Item
        : never
      : never
    : never,
): boolean {
  return (
    !waypoint.useGlobalHeadingParam &&
    (waypoint.headingMode === "fixed" ||
      waypoint.headingMode === "manually" ||
      (waypoint.headingMode === "smoothTransition" &&
        waypoint.headingAngle != null))
  );
}

function headingPath(
  waypoint: typeof useMissionStore.getState extends () => infer T
    ? T extends { waypoints: infer W }
      ? W extends Array<infer Item>
        ? Item
        : never
      : never
    : never,
  headingDeg: number,
  lengthM = 18,
): LatLng[] {
  const headingRad = deg2rad(headingDeg);
  const northM = Math.cos(headingRad) * lengthM;
  const eastM = Math.sin(headingRad) * lengthM;
  const [lat, lng] = offsetMeters(
    waypoint.latitude,
    waypoint.longitude,
    northM,
    eastM,
  );
  return [toLatLng(waypoint.latitude, waypoint.longitude), toLatLng(lat, lng)];
}

function computePlaneCorners(
  lat: number,
  lng: number,
  altitudeM: number,
  headingDeg: number,
  gimbalPitchDeg: number,
): [number, number, number][] {
  const H_FOV_DEG = 84;
  const V_FOV_DEG = 63;
  const PLANE_DIST = 15;

  const hHalf = Math.tan(deg2rad(H_FOV_DEG / 2)) * PLANE_DIST;
  const vHalf = Math.tan(deg2rad(V_FOV_DEG / 2)) * PLANE_DIST;
  const pitchRad = deg2rad(gimbalPitchDeg);
  const headingRad = deg2rad(headingDeg);
  const cosPitch = Math.cos(pitchRad);
  const sinPitch = Math.sin(pitchRad);

  const fwdE = Math.sin(headingRad) * cosPitch;
  const fwdN = Math.cos(headingRad) * cosPitch;
  const fwdU = sinPitch;
  const rightE = Math.cos(headingRad);
  const rightN = -Math.sin(headingRad);
  const upE = -Math.sin(headingRad) * sinPitch;
  const upN = -Math.cos(headingRad) * sinPitch;
  const upU = cosPitch;
  const cE = fwdE * PLANE_DIST;
  const cN = fwdN * PLANE_DIST;
  const cU = fwdU * PLANE_DIST;

  return [
    { h: -hHalf, v: vHalf },
    { h: hHalf, v: vHalf },
    { h: hHalf, v: -vHalf },
    { h: -hHalf, v: -vHalf },
  ].map(({ h, v }) => {
    const pE = cE + rightE * h + upE * v;
    const pN = cN + rightN * h + upN * v;
    const pU = cU + upU * v;
    const [pLat, pLng] = offsetMeters(lat, lng, pN, pE);
    return [pLat, pLng, altitudeM + pU];
  });
}

function selectionModeFromEvent(
  event: google.maps.MapMouseEvent | undefined,
): "replace" | "toggle" | "range" {
  const domEvent = event?.domEvent;
  if (domEvent instanceof MouseEvent) {
    if (domEvent.ctrlKey || domEvent.metaKey) return "toggle";
    if (domEvent.shiftKey) return "range";
  }
  return "replace";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeFootprint(points: LatLng[]): LatLng[] {
  if (points.length < 2) return points;
  const uniquePoints =
    points[0].lat === points[points.length - 1].lat &&
    points[0].lng === points[points.length - 1].lng
      ? points.slice(0, -1)
      : points;
  return uniquePoints.length >= 3 ? uniquePoints : points;
}

function footprintCentroid(points: LatLng[]): LatLng {
  const normalized = normalizeFootprint(points);
  if (normalized.length === 0) return { lat: 0, lng: 0 };

  const total = normalized.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 },
  );

  return {
    lat: total.lat / normalized.length,
    lng: total.lng / normalized.length,
  };
}

function fromLocalXY(origin: LatLng, x: number, y: number): LatLng {
  const [lat, lng] = offsetMeters(origin.lat, origin.lng, y, x);
  return { lat, lng };
}

function projectOnBearingAxis(
  point: { x: number; y: number },
  bearingDeg: number,
): { u: number; v: number } {
  const radians = deg2rad(bearingDeg);
  const axisEast = Math.sin(radians);
  const axisNorth = Math.cos(radians);

  return {
    u: point.x * axisEast + point.y * axisNorth,
    v: point.x * axisNorth - point.y * axisEast,
  };
}

function unprojectFromBearingAxis(
  origin: LatLng,
  bearingDeg: number,
  u: number,
  v: number,
): LatLng {
  const radians = deg2rad(bearingDeg);
  const x = u * Math.sin(radians) + v * Math.cos(radians);
  const y = u * Math.cos(radians) - v * Math.sin(radians);
  return fromLocalXY(origin, x, y);
}

function footprintAreaMeters(points: LatLng[]): number {
  const normalized = normalizeFootprint(points);
  if (normalized.length < 3) return 0;

  const origin = normalized[0];
  const localPoints = normalized.map((point) => toLocalXY(origin, point));
  let area = 0;

  for (let index = 0; index < localPoints.length; index++) {
    const current = localPoints[index];
    const next = localPoints[(index + 1) % localPoints.length];
    area += current.x * next.y - next.x * current.y;
  }

  return Math.abs(area / 2);
}

function longestEdgeBearing(points: LatLng[]): number | null {
  const normalized = normalizeFootprint(points);
  if (normalized.length < 2) return null;

  let bestBearing: number | null = null;
  let bestLength = 0;

  for (let index = 0; index < normalized.length; index++) {
    const start = normalized[index];
    const end = normalized[(index + 1) % normalized.length];
    const length = haversine(start.lat, start.lng, end.lat, end.lng);

    if (length <= bestLength) continue;

    bestLength = length;
    bestBearing = bearingTo(start.lat, start.lng, end.lat, end.lng);
  }

  return bestBearing;
}

function formatRoofStyleLabel(style: string): string {
  switch (style) {
    case "flat":
      return "Flat roof";
    case "gabled":
      return "Gabled roof";
    case "hipped":
      return "Hipped roof";
    case "skillion":
      return "Skillion roof";
    default:
      return `${style.charAt(0).toUpperCase()}${style.slice(1)} roof`;
  }
}

function heightSourceLabel(
  building: DetectedBuilding,
  fallbackHeightM: number,
): string {
  if (building.heightSource === "osm-height") {
    return "OSM height";
  }

  if (building.heightSource === "osm-levels") {
    return building.levels
      ? `OSM levels (${Math.round(building.levels)} floors)`
      : "OSM levels";
  }

  return `Footprint heuristic (${Math.round(fallbackHeightM)}m)`;
}

function polygonSignedArea(points: LatLng[]): number {
  const normalized = normalizeFootprint(points);
  let area = 0;
  for (let index = 0; index < normalized.length; index++) {
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length];
    area += current.lng * next.lat - next.lng * current.lat;
  }
  return area / 2;
}

function toLocalXY(origin: LatLng, point: LatLng): { x: number; y: number } {
  const x = (point.lng - origin.lng) * 111320 * Math.cos(deg2rad(origin.lat));
  const y = (point.lat - origin.lat) * 111320;
  return { x, y };
}

function pointToSegmentDistanceMeters(
  point: LatLng,
  start: LatLng,
  end: LatLng,
): number {
  const origin = start;
  const pointXY = toLocalXY(origin, point);
  const startXY = { x: 0, y: 0 };
  const endXY = toLocalXY(origin, end);
  const segmentDx = endXY.x - startXY.x;
  const segmentDy = endXY.y - startXY.y;
  const segmentLengthSq = segmentDx ** 2 + segmentDy ** 2;

  if (segmentLengthSq === 0) {
    return Math.hypot(pointXY.x - startXY.x, pointXY.y - startXY.y);
  }

  const t = clamp(
    ((pointXY.x - startXY.x) * segmentDx +
      (pointXY.y - startXY.y) * segmentDy) /
      segmentLengthSq,
    0,
    1,
  );

  const projectionX = startXY.x + t * segmentDx;
  const projectionY = startXY.y + t * segmentDy;
  return Math.hypot(pointXY.x - projectionX, pointXY.y - projectionY);
}

function footprintSelectionDistanceMeters(
  point: LatLng,
  footprint: LatLng[],
): number {
  const normalized = normalizeFootprint(footprint);
  if (normalized.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  if (
    pointInPolygon(
      [point.lat, point.lng],
      normalized.map((vertex) => [vertex.lat, vertex.lng]),
    )
  ) {
    return 0;
  }

  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < normalized.length; index += 1) {
    const start = normalized[index];
    const end = normalized[(index + 1) % normalized.length];
    bestDistance = Math.min(
      bestDistance,
      pointToSegmentDistanceMeters(point, start, end),
    );
  }

  return bestDistance;
}

function findSelectableRnbBuilding(
  point: LatLng,
  buildings: RnbBuilding[],
): RnbBuilding | null {
  const selectionThresholdM = 14;

  const bestMatch = buildings
    .map((building) => ({
      building,
      distanceM: footprintSelectionDistanceMeters(point, building.footprint),
    }))
    .filter((candidate) => candidate.distanceM <= selectionThresholdM)
    .sort((left, right) => left.distanceM - right.distanceM)[0];

  return bestMatch?.building ?? null;
}

function rankFacadeSegments(
  footprint: LatLng[],
  hintStart: LatLng,
  hintEnd: LatLng,
): FacadeSegmentOption[] {
  const normalized = normalizeFootprint(footprint);
  if (normalized.length < 2) return [];

  const clockwise = polygonSignedArea(normalized) < 0;
  const hintMid = {
    lat: (hintStart.lat + hintEnd.lat) / 2,
    lng: (hintStart.lng + hintEnd.lng) / 2,
  };

  return normalized
    .map((rawStart, index): FacadeSegmentOption | null => {
      const rawEnd = normalized[(index + 1) % normalized.length];
      const lengthM = haversine(
        rawStart.lat,
        rawStart.lng,
        rawEnd.lat,
        rawEnd.lng,
      );
      if (lengthM < 4) return null;

      const start = clockwise ? rawEnd : rawStart;
      const end = clockwise ? rawStart : rawEnd;
      const distanceToHintM = pointToSegmentDistanceMeters(hintMid, start, end);
      const hintBearing = bearingTo(
        hintStart.lat,
        hintStart.lng,
        hintEnd.lat,
        hintEnd.lng,
      );
      const segmentBearing = bearingTo(start.lat, start.lng, end.lat, end.lng);
      const angleDeltaDeg = Math.min(
        Math.abs(segmentBearing - hintBearing),
        360 - Math.abs(segmentBearing - hintBearing),
      );
      const score = distanceToHintM + angleDeltaDeg * 0.8;

      return {
        id: `segment-${index}`,
        label: `Facade ${index + 1}`,
        start,
        end,
        lengthM,
        distanceToHintM,
        angleDeltaDeg,
        score,
      };
    })
    .filter((segment): segment is FacadeSegmentOption => segment !== null)
    .sort((a, b) => a.score - b.score)
    .map((segment, index) => ({
      ...segment,
      label: `Facade ${index + 1}`,
    }));
}

function buildReconstructionPresets(
  building: DetectedBuilding,
  selectedSegment: FacadeSegmentOption | null,
): ReconstructionPresetOption[] {
  const footprint = normalizeFootprint(building.footprint);
  if (footprint.length < 3) return [];

  const latitudes = footprint.map((point) => point.lat);
  const longitudes = footprint.map((point) => point.lng);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const spanNorthSouthM = haversine(minLat, minLng, maxLat, minLng);
  const spanEastWestM = haversine(minLat, minLng, minLat, maxLng);
  const footprintSizeM = Math.max(spanNorthSouthM, spanEastWestM, 18);
  const estimatedHeightM = clamp(building.estimatedHeightM ?? 24, 12, 120);

  let longestEdgeLengthM = 0;
  let longestEdgeBearingDeg = 0;

  for (let index = 0; index < footprint.length; index++) {
    const current = footprint[index];
    const next = footprint[(index + 1) % footprint.length];
    const lengthM = haversine(current.lat, current.lng, next.lat, next.lng);
    if (lengthM > longestEdgeLengthM) {
      longestEdgeLengthM = lengthM;
      longestEdgeBearingDeg = bearingTo(
        current.lat,
        current.lng,
        next.lat,
        next.lng,
      );
    }
  }

  const rotationDeg =
    selectedSegment != null
      ? bearingTo(
          selectedSegment.start.lat,
          selectedSegment.start.lng,
          selectedSegment.end.lat,
          selectedSegment.end.lng,
        )
      : longestEdgeBearingDeg;

  const buildingGridAltitude = Math.round(clamp(estimatedHeightM + 22, 28, 90));
  const buildingGridSpacingM = Math.round(clamp(footprintSizeM / 7, 10, 18));
  const facadeDistanceM = Math.round(
    clamp(Math.max(12, estimatedHeightM * 0.55), 12, 28),
  );
  const denseFacadeDistanceM = Math.round(
    clamp(Math.max(10, estimatedHeightM * 0.42), 10, 20),
  );
  const facadeRows = Math.round(clamp(Math.ceil(estimatedHeightM / 6), 4, 8));
  const denseFacadeRows = Math.round(
    clamp(Math.ceil(estimatedHeightM / 4.5), 6, 10),
  );
  const facadeColumns = Math.round(
    clamp(selectedSegment ? Math.ceil(selectedSegment.lengthM / 5) : 7, 5, 12),
  );
  const denseFacadeColumns = Math.round(
    clamp(
      selectedSegment ? Math.ceil(selectedSegment.lengthM / 3.6) : 10,
      8,
      16,
    ),
  );

  return [
    {
      id: "roof-grid",
      label: "Roof nadir",
      detail: `${Math.round(estimatedHeightM + 28)}m • ${Math.round(clamp(footprintSizeM / 5, 8, 20))}m spacing`,
      description:
        "Classic nadir roof pass aligned to the footprint for top-down roof coverage.",
      templateType: "grid",
      gridParams: {
        ...DEFAULT_GRID_PARAMS,
        corner1: [minLat, minLng],
        corner2: [maxLat, maxLng],
        altitude: Math.round(clamp(estimatedHeightM + 28, 35, 120)),
        spacingM: Math.round(clamp(footprintSizeM / 5, 8, 20)),
        addPhotos: true,
        crosshatch: false,
        gimbalPitchAngle: -90,
        rotationDeg,
        reverse: false,
      },
    },
    {
      id: "building-grid-3d",
      label: "3D building grid",
      detail: `${buildingGridAltitude}m • ${buildingGridSpacingM}m spacing • cross-grid`,
      description:
        "Mission Planner style cross-grid with an oblique camera to keep roof and facades visible in the reconstruction.",
      templateType: "grid",
      gridParams: {
        ...DEFAULT_GRID_PARAMS,
        ...MISSION_PLANNER_3D_GRID_PARAMS,
        corner1: [minLat, minLng],
        corner2: [maxLat, maxLng],
        altitude: buildingGridAltitude,
        spacingM: buildingGridSpacingM,
        rotationDeg,
        reverse: false,
      },
    },
    ...(selectedSegment
      ? [
          {
            id: "vertical-facade",
            label: "Vertical facade",
            detail: `${facadeDistanceM}m standoff • ${facadeRows}x${facadeColumns}`,
            description:
              "Mission Planner style vertical facade pass aligned with the detected wall.",
            templateType: "facade" as const,
            facadeParams: {
              ...DEFAULT_FACADE_PARAMS,
              ...MISSION_PLANNER_VERTICAL_FACADE_PARAMS,
              point1: [
                selectedSegment.start.lat,
                selectedSegment.start.lng,
              ] as [number, number],
              point2: [selectedSegment.end.lat, selectedSegment.end.lng] as [
                number,
                number,
              ],
              distanceM: facadeDistanceM,
              minAltitude: Math.max(
                MISSION_PLANNER_VERTICAL_FACADE_PARAMS.minAltitude,
                6,
              ),
              maxAltitude: Math.round(clamp(estimatedHeightM + 8, 20, 90)),
              numRows: facadeRows,
              numColumns: facadeColumns,
            },
          },
          {
            id: "dense-facade",
            label: "Dense facade",
            detail: `${denseFacadeDistanceM}m standoff • ${denseFacadeRows}x${denseFacadeColumns}`,
            description:
              "Denser facade pass for tighter photogrammetry with more vertical and horizontal samples.",
            templateType: "facade" as const,
            facadeParams: {
              ...DEFAULT_FACADE_PARAMS,
              ...MISSION_PLANNER_DENSE_FACADE_PARAMS,
              point1: [
                selectedSegment.start.lat,
                selectedSegment.start.lng,
              ] as [number, number],
              point2: [selectedSegment.end.lat, selectedSegment.end.lng] as [
                number,
                number,
              ],
              distanceM: denseFacadeDistanceM,
              minAltitude: Math.max(
                MISSION_PLANNER_DENSE_FACADE_PARAMS.minAltitude,
                6,
              ),
              maxAltitude: Math.round(clamp(estimatedHeightM + 12, 24, 100)),
              numRows: denseFacadeRows,
              numColumns: denseFacadeColumns,
            },
          },
        ]
      : []),
    {
      id: "oblique-orbit",
      label: "Oblique orbit",
      detail: `${Math.round(clamp(footprintSizeM * 0.7, 18, 70))}m radius • ${Math.round(clamp(estimatedHeightM + 18, 25, 120))}m alt`,
      description:
        "Circular oblique ring around the footprint to capture facades and roof edges.",
      templateType: "orbit",
      orbitParams: {
        ...DEFAULT_ORBIT_PARAMS,
        center: [building.centroid.lat, building.centroid.lng],
        radiusM: Math.round(clamp(footprintSizeM * 0.7, 18, 70)),
        altitude: Math.round(clamp(estimatedHeightM + 18, 25, 120)),
        numPoints: Math.round(clamp(Math.ceil(footprintSizeM / 6) + 6, 10, 20)),
        clockwise: true,
        createPoi: true,
      },
    },
  ];
}

function buildFacadeVariants(
  baseFacadeParams: FacadeParams,
  building: DetectedBuilding,
  segment: FacadeSegmentOption,
): FacadeVariantOption[] {
  const estimatedHeightM = clamp(
    Math.round((building.estimatedHeightM ?? baseFacadeParams.maxAltitude) + 4),
    12,
    120,
  );

  const profiles = [
    {
      id: "balanced",
      label: "Balanced",
      distanceMultiplier: 0.55,
      verticalFactor: 0.4,
      horizontalFactor: 0.55,
    },
    {
      id: "detail",
      label: "Detail",
      distanceMultiplier: 0.48,
      verticalFactor: 0.32,
      horizontalFactor: 0.45,
    },
    {
      id: "efficient",
      label: "Efficient",
      distanceMultiplier: 0.68,
      verticalFactor: 0.52,
      horizontalFactor: 0.72,
    },
  ] as const;

  return profiles
    .map((profile) => {
      const distanceM = clamp(
        Math.round(
          Math.max(
            8,
            Math.min(35, estimatedHeightM * profile.distanceMultiplier),
          ),
        ),
        8,
        35,
      );
      const verticalStepM = Math.max(3.5, distanceM * profile.verticalFactor);
      const horizontalStepM = Math.max(
        3.5,
        distanceM * profile.horizontalFactor,
      );
      const numRows = clamp(
        Math.ceil(estimatedHeightM / verticalStepM) + 1,
        2,
        12,
      );
      const numColumns = clamp(
        Math.ceil(segment.lengthM / horizontalStepM) + 1,
        3,
        24,
      );

      const params: FacadeParams = {
        ...baseFacadeParams,
        point1: [segment.start.lat, segment.start.lng],
        point2: [segment.end.lat, segment.end.lng],
        distanceM,
        minAltitude: Math.min(baseFacadeParams.minAltitude, 8),
        maxAltitude: Math.max(
          baseFacadeParams.minAltitude + 5,
          estimatedHeightM,
        ),
        numRows,
        numColumns,
        addPhotos: true,
      };

      const actualVerticalStep = estimatedHeightM / Math.max(1, numRows - 1);
      const actualHorizontalStep =
        segment.lengthM / Math.max(1, numColumns - 1);
      const targetVerticalStep = Math.max(3.5, distanceM * 0.42);
      const targetHorizontalStep = Math.max(3.5, distanceM * 0.58);
      const coverage =
        (Math.min(1, targetVerticalStep / actualVerticalStep) +
          Math.min(1, targetHorizontalStep / actualHorizontalStep)) /
        2;
      const efficiency = clamp(
        18 / Math.max(12, numRows * numColumns),
        0.35,
        1,
      );
      const safety =
        1 -
        Math.min(
          1,
          Math.abs(distanceM - clamp(estimatedHeightM * 0.55, 10, 24)) / 20,
        );
      const framing =
        1 - Math.min(1, Math.abs(distanceM / estimatedHeightM - 0.55));
      const score =
        coverage * 0.45 + efficiency * 0.25 + safety * 0.15 + framing * 0.15;

      return {
        id: profile.id,
        label: profile.label,
        params,
        score,
        detail: `${numColumns}x${numRows} • ${distanceM}m • ${(score * 100).toFixed(0)}%`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildFacadeScenario(
  baseFacadeParams: FacadeParams,
  building: DetectedBuilding,
  selectedSegmentId?: string | null,
  selectedVariantId?: string | null,
): {
  segments: FacadeSegmentOption[];
  selectedSegment: FacadeSegmentOption;
  variants: FacadeVariantOption[];
  selectedVariant: FacadeVariantOption;
} | null {
  const segments = rankFacadeSegments(
    building.footprint,
    { lat: baseFacadeParams.point1[0], lng: baseFacadeParams.point1[1] },
    { lat: baseFacadeParams.point2[0], lng: baseFacadeParams.point2[1] },
  ).slice(0, 6);

  if (segments.length === 0) return null;

  const selectedSegment =
    segments.find((segment) => segment.id === selectedSegmentId) ?? segments[0];
  const variants = buildFacadeVariants(
    baseFacadeParams,
    building,
    selectedSegment,
  );
  const selectedVariant =
    variants.find((variant) => variant.id === selectedVariantId) ?? variants[0];

  return {
    segments,
    selectedSegment,
    variants,
    selectedVariant,
  };
}

function buildBuildings3DView(args: {
  templatePreview: TemplateResult | null;
  activeTemplateType: TemplateMode;
  detectedBuilding: DetectedBuilding | null;
  selectedSegment: FacadeSegmentOption | null;
  facadeParams: FacadeParams | null;
  selectedWaypoint:
    | ReturnType<typeof useMissionStore.getState>["waypoints"][number]
    | null;
  selectedWaypointHeading: number | null;
  mainMapViewport: MainMapViewport | null;
  defaultMapView: { latitude: number; longitude: number; zoom: number };
}): Buildings3DView {
  const {
    templatePreview,
    activeTemplateType,
    detectedBuilding,
    selectedSegment,
    facadeParams,
    selectedWaypoint,
    selectedWaypointHeading,
    mainMapViewport,
    defaultMapView,
  } = args;

  if (templatePreview && activeTemplateType) {
    const templatePoints = [
      ...templatePreview.waypoints.map((waypoint) => ({
        lat: waypoint.latitude,
        lng: waypoint.longitude,
      })),
      ...templatePreview.pois.map((poi) => ({
        lat: poi.latitude,
        lng: poi.longitude,
      })),
    ];

    if (templatePoints.length > 0) {
      const latitudes = templatePoints.map((point) => point.lat);
      const longitudes = templatePoints.map((point) => point.lng);
      const minLat = Math.min(...latitudes);
      const maxLat = Math.max(...latitudes);
      const minLng = Math.min(...longitudes);
      const maxLng = Math.max(...longitudes);
      const diagonalM = haversine(minLat, minLng, maxLat, maxLng);
      const maxTemplateAltitude = Math.max(
        30,
        ...templatePreview.waypoints.map((waypoint) => waypoint.height),
      );
      const heading = selectedSegment
        ? (bearingTo(
            selectedSegment.start.lat,
            selectedSegment.start.lng,
            selectedSegment.end.lat,
            selectedSegment.end.lng,
          ) +
            90) %
          360
        : facadeParams
          ? (bearingTo(
              facadeParams.point1[0],
              facadeParams.point1[1],
              facadeParams.point2[0],
              facadeParams.point2[1],
            ) +
              90) %
            360
          : templatePoints.length >= 2
            ? bearingTo(
                templatePoints[0].lat,
                templatePoints[0].lng,
                templatePoints[templatePoints.length - 1].lat,
                templatePoints[templatePoints.length - 1].lng,
              )
            : (mainMapViewport?.heading ?? 0);
      const range = clamp(
        Math.max(
          diagonalM * (activeTemplateType === "facade" ? 2.8 : 2.35),
          activeTemplateType === "facade"
            ? (selectedSegment?.lengthM ?? 36) * 4.6
            : 170,
        ),
        140,
        3200,
      );
      const subtitle =
        activeTemplateType === "facade"
          ? "Focused on the current facade template"
          : `Focused on the current ${activeTemplateType} template`;

      return {
        center: {
          lat: (minLat + maxLat) / 2,
          lng: (minLng + maxLng) / 2,
          altitude: Math.max(maxTemplateAltitude * 1.8, range * 0.35),
        },
        range,
        heading,
        tilt: activeTemplateType === "facade" ? 67.5 : 62.5,
        title: "Google Buildings 3D",
        subtitle,
      };
    }
  }

  if (mainMapViewport) {
    const latitudeFactor = Math.max(
      0.35,
      Math.cos(deg2rad(mainMapViewport.center.lat)),
    );
    const groundResolutionMPerPixel =
      (156543.03392 * latitudeFactor) / 2 ** mainMapViewport.zoom;
    const range = clamp(groundResolutionMPerPixel * 720, 140, 3200);
    const subtitle = detectedBuilding
      ? "Synced to the current main map view around the detected building"
      : selectedWaypoint
        ? `Synced to the current main map view near ${selectedWaypoint.name}`
        : "Synced to the current main map view";

    return {
      center: {
        lat: mainMapViewport.center.lat,
        lng: mainMapViewport.center.lng,
        altitude: Math.max(90, range * 0.35),
      },
      range,
      heading: mainMapViewport.heading,
      tilt: mainMapViewport.tilt > 0 ? 67.5 : 55,
      title: "Google Buildings 3D",
      subtitle,
    };
  }

  if (detectedBuilding) {
    const center = {
      lat: detectedBuilding.centroid.lat,
      lng: detectedBuilding.centroid.lng,
      altitude: Math.max(80, (detectedBuilding.estimatedHeightM ?? 30) * 2.5),
    };
    const heading = selectedSegment
      ? (bearingTo(
          selectedSegment.start.lat,
          selectedSegment.start.lng,
          selectedSegment.end.lat,
          selectedSegment.end.lng,
        ) +
          90) %
        360
      : facadeParams
        ? (bearingTo(
            facadeParams.point1[0],
            facadeParams.point1[1],
            facadeParams.point2[0],
            facadeParams.point2[1],
          ) +
            90) %
          360
        : 0;
    const referenceLength = selectedSegment?.lengthM ?? 40;

    return {
      center,
      range: clamp(referenceLength * 5, 120, 650),
      heading,
      tilt: 67.5,
      title: "Google Buildings 3D",
      subtitle: detectedBuilding.estimatedHeightM
        ? `Photorealistic building view, estimated ${Math.round(detectedBuilding.estimatedHeightM)}m high`
        : "Photorealistic building view centered on the detected footprint",
    };
  }

  if (selectedWaypoint) {
    return {
      center: {
        lat: selectedWaypoint.latitude,
        lng: selectedWaypoint.longitude,
        altitude: Math.max(90, selectedWaypoint.height * 2),
      },
      range: 220,
      heading: selectedWaypointHeading ?? 0,
      tilt: 65,
      title: "Google Buildings 3D",
      subtitle: `Centered on ${selectedWaypoint.name}`,
    };
  }

  return {
    center: {
      lat: defaultMapView.latitude,
      lng: defaultMapView.longitude,
      altitude: 180,
    },
    range: 450,
    heading: 0,
    tilt: 55,
    title: "Google Buildings 3D",
    subtitle: "Photorealistic city view around the current mission area",
  };
}

async function resolveStreetViewContext(
  building: DetectedBuilding,
  selectedSegment: FacadeSegmentOption | null,
): Promise<StreetViewContext> {
  if (typeof google === "undefined" || !google.maps?.StreetViewService) {
    return {
      status: "unknown",
      panoramaLocation: null,
      distanceM: null,
      headingFromBuildingDeg: null,
      label: "Street View unavailable in this session",
    };
  }

  const targetPoint = selectedSegment
    ? segmentMidpoint(selectedSegment)
    : building.centroid;

  return new Promise((resolve) => {
    const service = new google.maps.StreetViewService();
    service.getPanorama(
      {
        location: targetPoint,
        radius: clamp(Math.max(30, building.distanceToQueryM + 24), 30, 90),
      },
      (result, status) => {
        if (
          status !== google.maps.StreetViewStatus.OK ||
          !result?.location?.latLng
        ) {
          resolve({
            status: "unavailable",
            panoramaLocation: null,
            distanceM: null,
            headingFromBuildingDeg: null,
            label: "No nearby Street View cue",
          });
          return;
        }

        const panoramaLocation = result.location.latLng.toJSON();
        const distanceM = haversine(
          targetPoint.lat,
          targetPoint.lng,
          panoramaLocation.lat,
          panoramaLocation.lng,
        );

        resolve({
          status: "available",
          panoramaLocation,
          distanceM,
          headingFromBuildingDeg: bearingTo(
            building.centroid.lat,
            building.centroid.lng,
            panoramaLocation.lat,
            panoramaLocation.lng,
          ),
          label: `Street View cue ${Math.round(distanceM)}m away`,
        });
      },
    );
  });
}

function buildApproximateBuildingShell(
  building: DetectedBuilding | null,
  selectedSegment: FacadeSegmentOption | null,
  streetViewContext: StreetViewContext | null,
): ReconstructedBuildingShell | null {
  if (!building) return null;

  const normalizedFootprint = normalizeFootprint(building.footprint);
  if (normalizedFootprint.length < 3) return null;

  const centroid = footprintCentroid(normalizedFootprint);
  const footprintAreaM2 = footprintAreaMeters(normalizedFootprint);
  const primaryBearing =
    (selectedSegment
      ? bearingTo(
          selectedSegment.start.lat,
          selectedSegment.start.lng,
          selectedSegment.end.lat,
          selectedSegment.end.lng,
        )
      : null) ??
    longestEdgeBearing(normalizedFootprint) ??
    0;
  const primaryLocalPoints = normalizedFootprint.map((point) =>
    projectOnBearingAxis(toLocalXY(centroid, point), primaryBearing),
  );
  const primaryWidth = Math.max(
    1,
    ...primaryLocalPoints.map((point) => Math.abs(point.u)),
  );
  const primaryDepth = Math.max(
    1,
    ...primaryLocalPoints.map((point) => Math.abs(point.v)),
  );
  const aspectRatio =
    Math.max(primaryWidth, primaryDepth) /
    Math.max(1, Math.min(primaryWidth, primaryDepth));
  const heuristicHeightM = clamp(
    12 +
      Math.sqrt(Math.max(footprintAreaM2, 1)) * 0.32 +
      (aspectRatio < 1.25 ? 3 : 0),
    11,
    48,
  );
  const estimatedHeightM = clamp(
    building.estimatedHeightM ?? heuristicHeightM,
    12,
    120,
  );
  const explicitRoofShape = building.roofShape?.trim().toLowerCase() ?? null;

  let roofStyle = explicitRoofShape;
  if (
    roofStyle !== "flat" &&
    roofStyle !== "gabled" &&
    roofStyle !== "hipped" &&
    roofStyle !== "skillion"
  ) {
    roofStyle = null;
  }

  if (!roofStyle) {
    if (estimatedHeightM < 15 && footprintAreaM2 > 550) {
      roofStyle = "flat";
    } else if (aspectRatio > 1.4) {
      roofStyle = "gabled";
    } else {
      roofStyle = "hipped";
    }
  }

  const streetViewBearing = streetViewContext?.headingFromBuildingDeg ?? null;
  const roofBearingDeg =
    building.roofDirectionDeg ??
    (aspectRatio < 1.2 && streetViewBearing != null
      ? (streetViewBearing + 90) % 360
      : primaryBearing);
  const projectedPoints = normalizedFootprint.map((point) =>
    projectOnBearingAxis(toLocalXY(centroid, point), roofBearingDeg),
  );
  const minU = Math.min(...projectedPoints.map((point) => point.u));
  const maxU = Math.max(...projectedPoints.map((point) => point.u));
  const minV = Math.min(...projectedPoints.map((point) => point.v));
  const maxV = Math.max(...projectedPoints.map((point) => point.v));
  const maxAbsU = Math.max(1, Math.abs(minU), Math.abs(maxU));
  const maxAbsV = Math.max(1, Math.abs(minV), Math.abs(maxV));
  const roofRiseM =
    roofStyle === "flat"
      ? 0
      : clamp(
          building.roofHeightM ??
            estimatedHeightM *
              (roofStyle === "gabled"
                ? 0.14
                : roofStyle === "hipped"
                  ? 0.11
                  : 0.1) +
              (streetViewContext?.status === "available" ? 0.8 : 0),
          1.8,
          Math.min(estimatedHeightM * 0.28, 12),
        );
  const wallHeightM = clamp(estimatedHeightM - roofRiseM, 8, estimatedHeightM);

  const roofCoordinates = normalizedFootprint.map((point, index) => {
    const projected = projectedPoints[index];
    let roofFactor = 0;

    if (roofStyle === "gabled") {
      roofFactor = 1 - Math.abs(projected.v) / maxAbsV;
    } else if (roofStyle === "hipped") {
      roofFactor =
        1 -
        Math.max(
          Math.abs(projected.u) / maxAbsU,
          Math.abs(projected.v) / maxAbsV,
        );
    } else if (roofStyle === "skillion") {
      roofFactor = (projected.v - minV) / Math.max(1, maxV - minV);
    }

    return {
      lat: point.lat,
      lng: point.lng,
      altitude: wallHeightM + roofRiseM * clamp(roofFactor, 0, 1),
    };
  });

  const ridgeCoordinates =
    roofStyle === "flat"
      ? null
      : (() => {
          const ridgeHalfSpan =
            roofStyle === "hipped" ? (maxU - minU) * 0.2 : (maxU - minU) * 0.45;
          const ridgeStart = unprojectFromBearingAxis(
            centroid,
            roofBearingDeg,
            clamp(-ridgeHalfSpan, minU, maxU),
            0,
          );
          const ridgeEnd = unprojectFromBearingAxis(
            centroid,
            roofBearingDeg,
            clamp(ridgeHalfSpan, minU, maxU),
            0,
          );

          return [ridgeStart, ridgeEnd].map((point) => ({
            lat: point.lat,
            lng: point.lng,
            altitude: estimatedHeightM,
          }));
        })();

  const baseConfidence = clamp(building.confidence, 0, 1);
  const heightConfidence =
    building.heightSource === "osm-height"
      ? 0.96
      : building.heightSource === "osm-levels"
        ? 0.82
        : 0.6;
  const streetViewConfidence =
    streetViewContext?.status === "available"
      ? clamp(1 - (streetViewContext.distanceM ?? 75) / 70, 0.35, 1)
      : streetViewContext?.status === "unknown"
        ? 0.45
        : 0.25;
  const roofConfidence = building.roofShape ? 0.9 : 0.55;
  const confidencePercent = Math.round(
    clamp(
      baseConfidence * 0.55 +
        heightConfidence * 0.25 +
        streetViewConfidence * 0.1 +
        roofConfidence * 0.1,
      0.42,
      0.97,
    ) * 100,
  );
  const resolvedHeightSourceLabel = heightSourceLabel(
    building,
    heuristicHeightM,
  );
  const roofStyleLabel = formatRoofStyleLabel(roofStyle);
  const streetViewLabel = streetViewContext?.label ?? "Street View cue pending";

  return {
    roofCoordinates,
    ridgeCoordinates,
    estimatedHeightM,
    wallHeightM,
    roofPeakHeightM: estimatedHeightM,
    confidencePercent,
    roofStyleLabel,
    heightSourceLabel: resolvedHeightSourceLabel,
    streetViewLabel,
    sourceSummary: [
      "OSM footprint",
      resolvedHeightSourceLabel,
      "Google Buildings 3D context",
      streetViewLabel,
    ].join(" • "),
    note: `Hybrid estimate using OSM footprint, ${resolvedHeightSourceLabel.toLowerCase()}, Google 3D context, and ${streetViewLabel.toLowerCase()}. The ${roofStyleLabel.toLowerCase()} is still heuristic, so the model remains approximate.`,
  };
}

function segmentMidpoint(segment: FacadeSegmentOption): LatLng {
  return {
    lat: (segment.start.lat + segment.end.lat) / 2,
    lng: (segment.start.lng + segment.end.lng) / 2,
  };
}

function buildBuildings3DMarkers(args: {
  detectedBuilding: DetectedBuilding | null;
  selectedSegment: FacadeSegmentOption | null;
  facadeRecommendation: FacadeCopilotRecommendation | null;
  streetViewContext: StreetViewContext | null;
}): Buildings3DMarker[] {
  const {
    detectedBuilding,
    selectedSegment,
    facadeRecommendation,
    streetViewContext,
  } = args;
  const markers: Buildings3DMarker[] = [];

  if (detectedBuilding) {
    markers.push({
      id: "building-centroid",
      position: detectedBuilding.centroid,
      glyph: "B",
      label: "Building centroid",
      background: "#0891b2",
      borderColor: "#67e8f9",
      glyphColor: "#082f49",
      scale: 1.1,
    });
  }

  if (selectedSegment) {
    markers.push(
      {
        id: "facade-start",
        position: selectedSegment.start,
        glyph: "1",
        label: `${selectedSegment.label} start`,
        background: "#f97316",
        borderColor: "#fdba74",
        glyphColor: "#431407",
      },
      {
        id: "facade-end",
        position: selectedSegment.end,
        glyph: "2",
        label: `${selectedSegment.label} end`,
        background: "#f97316",
        borderColor: "#fdba74",
        glyphColor: "#431407",
      },
      {
        id: "facade-midpoint",
        position: segmentMidpoint(selectedSegment),
        glyph:
          facadeRecommendation?.currentVariantMatchesRecommendation === false
            ? "R"
            : "S",
        label:
          facadeRecommendation?.currentVariantMatchesRecommendation === false
            ? `Recommended: ${facadeRecommendation.recommendedVariantLabel}`
            : `Selected: ${facadeRecommendation?.recommendedVariantLabel ?? selectedSegment.label}`,
        background:
          facadeRecommendation?.currentVariantMatchesRecommendation === false
            ? "#14b8a6"
            : "#22c55e",
        borderColor:
          facadeRecommendation?.currentVariantMatchesRecommendation === false
            ? "#99f6e4"
            : "#86efac",
        glyphColor: "#052e16",
        scale: 1.15,
      },
    );
  }

  if (
    streetViewContext?.status === "available" &&
    streetViewContext.panoramaLocation
  ) {
    markers.push({
      id: "street-view-cue",
      position: streetViewContext.panoramaLocation,
      glyph: "SV",
      label: streetViewContext.label,
      background: "#7c3aed",
      borderColor: "#c4b5fd",
      glyphColor: "#f5f3ff",
      scale: 1.05,
    });
  }

  return markers;
}

function toGroundPolygonCoordinates(
  footprint: LatLng[],
): google.maps.LatLngAltitudeLiteral[] {
  return footprint.map((point) => ({
    lat: point.lat,
    lng: point.lng,
    altitude: 0,
  }));
}

function Buildings3DPanel({
  open,
  view,
  markers,
  showRnbLayer,
  rnbBuildings,
  selectedRnbBuildingId,
  detectedBuilding: _detectedBuilding,
  reconstructionShell,
  contextShells,
  scanRoute,
  streetViewContext: _streetViewContext,
  selectedSegment,
  facadeRecommendation,
  onClose,
}: {
  open: boolean;
  view: Buildings3DView;
  markers: Buildings3DMarker[];
  showRnbLayer: boolean;
  rnbBuildings: RnbBuilding[];
  selectedRnbBuildingId: string | null;
  detectedBuilding: DetectedBuilding | null;
  reconstructionShell: ReconstructedBuildingShell | null;
  contextShells: Array<{ id: string; shell: ReconstructedBuildingShell }>;
  scanRoute: Buildings3DScanRoute | null;
  streetViewContext: StreetViewContext | null;
  selectedSegment: FacadeSegmentOption | null;
  facadeRecommendation: FacadeCopilotRecommendation | null;
  onClose: () => void;
}) {
  if (!open) return null;

  const approximateBuildingShell = reconstructionShell;
  const routeWaypointMarkers = scanRoute?.waypointMarkers ?? [];
  const asPolygon3DPath = (
    path: Iterable<
      | google.maps.LatLngAltitude
      | google.maps.LatLngAltitudeLiteral
      | google.maps.LatLngLiteral
    >,
  ) => path as unknown as string;

  return (
    <div className="absolute inset-0 z-0 flex flex-col overflow-hidden bg-background">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
            {view.title}
          </p>
          <p className="text-[11px] text-muted-foreground">{view.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          2D
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-black/30">
        <Map3D
          key={`${view.center.lat.toFixed(6)}-${view.center.lng.toFixed(6)}-${Math.round(view.heading)}-${Math.round(view.range)}`}
          defaultCenter={view.center}
          defaultRange={view.range}
          defaultHeading={view.heading}
          defaultTilt={view.tilt}
          mode={MapMode.SATELLITE}
          gestureHandling={GestureHandling.GREEDY}
          style={{ width: "100%", height: "100%" }}
        >
          {rnbBuildings.map((building) => {
            const isSelected = building.rnbId === selectedRnbBuildingId;
            return (
              <gmp-polygon-3d
                key={`rnb-footprint-${building.rnbId}`}
                altitudeMode={
                  AltitudeMode.CLAMP_TO_GROUND as unknown as google.maps.maps3d.AltitudeMode
                }
                path={asPolygon3DPath(
                  toGroundPolygonCoordinates(building.footprint),
                )}
                fillColor={
                  isSelected
                    ? "rgba(34, 211, 238, 0.28)"
                    : "rgba(56, 189, 248, 0.14)"
                }
                strokeColor={isSelected ? "#22d3ee" : "#0ea5e9"}
                strokeWidth={isSelected ? 3 : 2}
                drawsOccludedSegments
                zIndex={isSelected ? 26 : 14}
              />
            );
          })}
          {contextShells.map(({ id, shell }) => (
            <gmp-polygon-3d
              key={`context-shell-${id}`}
              altitudeMode={
                AltitudeMode.RELATIVE_TO_GROUND as unknown as google.maps.maps3d.AltitudeMode
              }
              path={asPolygon3DPath(shell.roofCoordinates)}
              fillColor="rgba(148, 163, 184, 0.16)"
              strokeColor="#94a3b8"
              strokeWidth={1}
              extruded
              drawsOccludedSegments
              zIndex={12}
            />
          ))}
          {scanRoute && scanRoute.path.length >= 2 && (
            <gmp-polyline-3d
              altitudeMode={
                AltitudeMode.RELATIVE_TO_GROUND as unknown as google.maps.maps3d.AltitudeMode
              }
              coordinates={scanRoute.path}
              strokeColor="#f59e0b"
              strokeWidth={3}
              outerColor="#7c2d12"
              outerWidth={1}
              drawsOccludedSegments
              zIndex={18}
            />
          )}
          {approximateBuildingShell && (
            <gmp-polygon-3d
              altitudeMode={
                AltitudeMode.RELATIVE_TO_GROUND as unknown as google.maps.maps3d.AltitudeMode
              }
              path={asPolygon3DPath(approximateBuildingShell.roofCoordinates)}
              fillColor="rgba(20, 184, 166, 0.22)"
              strokeColor="#2dd4bf"
              strokeWidth={2}
              extruded
              drawsOccludedSegments
              zIndex={20}
            />
          )}
          {approximateBuildingShell?.ridgeCoordinates && (
            <gmp-polyline-3d
              altitudeMode={
                AltitudeMode.RELATIVE_TO_GROUND as unknown as google.maps.maps3d.AltitudeMode
              }
              coordinates={approximateBuildingShell.ridgeCoordinates}
              strokeColor="#ccfbf1"
              strokeWidth={2}
              outerColor="#134e4a"
              outerWidth={1}
              drawsOccludedSegments
              zIndex={24}
            />
          )}
          {routeWaypointMarkers.map((marker) => (
            <Marker3D
              key={marker.id}
              position={marker.position}
              altitudeMode={AltitudeMode.RELATIVE_TO_GROUND}
            >
              <Pin
                glyph={marker.glyph}
                background={marker.background}
                borderColor={marker.borderColor}
                glyphColor={marker.glyphColor}
                scale={marker.scale}
              />
            </Marker3D>
          ))}
          {markers.map((marker) => (
            <Marker3D
              key={marker.id}
              position={marker.position}
              altitudeMode={AltitudeMode.CLAMP_TO_GROUND}
            >
              <Pin
                glyph={marker.glyph}
                background={marker.background}
                borderColor={marker.borderColor}
                glyphColor={marker.glyphColor}
                scale={marker.scale}
              />
            </Marker3D>
          ))}
        </Map3D>
        {showRnbLayer && rnbBuildings.length === 0 && (
          <div className="pointer-events-none absolute right-3 top-3 max-w-[260px] rounded-md border border-sky-500/25 bg-background/88 px-3 py-2 text-[10px] shadow-lg backdrop-blur-sm">
            <p className="font-medium text-foreground">Bâtiments 2D</p>
            <p className="text-muted-foreground">
              Aucune emprise RNB visible dans cette zone.
            </p>
          </div>
        )}
        {contextShells.length > 0 && (
          <div className="pointer-events-none absolute left-3 top-3 max-w-[260px] rounded-md border border-slate-400/30 bg-background/88 px-3 py-2 text-[10px] shadow-lg backdrop-blur-sm">
            <p className="font-medium text-foreground">Fallback OSM massing</p>
            <p className="text-muted-foreground">
              {contextShells.length} nearby building
              {contextShells.length > 1 ? "s" : ""} extruded for areas where
              Google Buildings 3D is sparse.
            </p>
          </div>
        )}
        {facadeRecommendation && selectedSegment && (
          <div className="pointer-events-none absolute right-3 bottom-3 max-w-[260px] rounded-md border border-cyan-500/30 bg-background/88 px-3 py-2 text-[10px] shadow-lg backdrop-blur-sm">
            <p className="font-medium text-foreground">Copilot in 3D</p>
            <p className="text-muted-foreground">
              Goal: {facadeRecommendation.objectiveLabel}
            </p>
            <p className="text-muted-foreground">
              Facade: {selectedSegment.label} •{" "}
              {selectedSegment.lengthM.toFixed(0)}m
            </p>
            <p className="text-cyan-200">
              Recommended: {facadeRecommendation.recommendedVariantLabel}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function obstaclePath(vertices: [number, number][]): LatLng[] {
  return vertices.map(([lat, lng]) => ({ lat, lng }));
}

function rectanglePath(a: [number, number], b: [number, number]): LatLng[] {
  return [
    { lat: a[0], lng: a[1] },
    { lat: a[0], lng: b[1] },
    { lat: b[0], lng: b[1] },
    { lat: b[0], lng: a[1] },
  ];
}

function circlePath(center: [number, number], radiusM: number): LatLng[] {
  const [lat, lng] = center;
  const coords: LatLng[] = [];
  for (let i = 0; i <= 64; i++) {
    const angle = (i / 64) * 2 * Math.PI;
    const dLat = (radiusM / 6371000) * Math.cos(angle) * (180 / Math.PI);
    const dLng =
      ((radiusM / 6371000) * Math.sin(angle) * (180 / Math.PI)) /
      Math.cos((lat * Math.PI) / 180);
    coords.push({ lat: lat + dLat, lng: lng + dLng });
  }
  return coords;
}

function geometryToPaths(geometry: GeoJSON.Geometry): LatLng[][] {
  if (geometry.type === "Polygon") {
    return [
      (geometry.coordinates[0] as [number, number][]).map(([lng, lat]) => ({
        lat,
        lng,
      })),
    ];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygon) =>
      (polygon[0] as [number, number][]).map(([lng, lat]) => ({ lat, lng })),
    );
  }
  return [];
}

function FitBoundsOnLoad() {
  const map = useMap();
  const waypoints = useMissionStore((s) => s.waypoints);
  const pois = useMissionStore((s) => s.pois);
  const obstacles = useMissionStore((s) => s.obstacles);
  const prevCountRef = useRef(0);

  useEffect(() => {
    const wasEmpty = prevCountRef.current === 0;
    prevCountRef.current = waypoints.length;
    if (!map || !wasEmpty || waypoints.length < 2) return;

    const bounds = new google.maps.LatLngBounds();
    for (const waypoint of waypoints)
      bounds.extend(toLatLng(waypoint.latitude, waypoint.longitude));
    for (const poi of pois)
      bounds.extend(toLatLng(poi.latitude, poi.longitude));
    for (const obstacle of obstacles) {
      for (const [lat, lng] of obstacle.vertices) bounds.extend({ lat, lng });
    }

    if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
  }, [map, waypoints, pois, obstacles]);

  return null;
}

function MainMapViewportSync({
  onChange,
}: {
  onChange: (viewport: MainMapViewport) => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    const publish = () => {
      const center = map.getCenter();
      if (!center) return;

      onChange({
        center: center.toJSON(),
        zoom: map.getZoom() ?? 15,
        heading: map.getHeading() ?? 0,
        tilt: map.getTilt() ?? 0,
      });
    };

    publish();
    const listener = map.addListener("idle", publish);
    return () => listener.remove();
  }, [map, onChange]);

  return null;
}

function MapSearch({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const map = useMap();
  const [error, setError] = useState("");

  const handleSearch = useCallback(() => {
    if (!map || !value.trim()) return;
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: value }, (results, status) => {
      if (status !== "OK" || !results?.[0]) {
        setError("Location not found.");
        return;
      }

      setError("");
      const first = results[0];
      if (first.geometry.viewport) {
        map.fitBounds(first.geometry.viewport);
      } else if (first.geometry.location) {
        map.panTo(first.geometry.location);
        map.setZoom(15);
      }
    });
  }, [map, value]);

  return (
    <>
      <div className="absolute left-4 top-4 z-10 flex w-[320px] gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
        <input
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSearch();
          }}
          placeholder="Search location..."
          className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
        />
        <button
          className="rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          onClick={handleSearch}
        >
          Search
        </button>
      </div>
      {error && (
        <div className="absolute left-4 top-16 z-10 rounded-md bg-destructive/90 px-3 py-2 text-xs text-destructive-foreground shadow">
          {error}
        </div>
      )}
    </>
  );
}

function AirspaceLayer() {
  const enabled = useAirspaceStore((s) => s.enabled);
  const zones = useAirspaceStore((s) => s.zones);
  const fetchForBounds = useAirspaceStore((s) => s.fetchForBounds);
  const map = useMap();
  const [hoveredZone, setHoveredZone] = useState<{
    position: LatLng;
    name: string;
    category: string;
    severity: string;
  } | null>(null);

  useEffect(() => {
    if (!map || !enabled) return;
    const refresh = () => {
      const bounds = map.getBounds();
      if (!bounds) return;
      fetchForBounds(
        bounds.getSouthWest().lat(),
        bounds.getSouthWest().lng(),
        bounds.getNorthEast().lat(),
        bounds.getNorthEast().lng(),
      );
    };

    refresh();
    const listener = map.addListener("idle", refresh);
    return () => listener.remove();
  }, [map, enabled, fetchForBounds]);

  if (!enabled) return null;

  return (
    <>
      {zones.flatMap((zone) =>
        geometryToPaths(zone.geometry).map((path, index) => {
          const color = zone.severity === "prohibited" ? "#ef4444" : "#f97316";
          return (
            <PolygonOverlay
              key={`${zone.id}-${index}`}
              path={path}
              strokeColor={color}
              fillColor={color}
              fillOpacity={zone.severity === "prohibited" ? 0.22 : 0.16}
              clickable
              onClick={(position) => {
                setHoveredZone({
                  position,
                  name: zone.name || zone.id,
                  category: zone.category || "",
                  severity: zone.severity,
                });
              }}
            />
          );
        }),
      )}
      {hoveredZone && (
        <InfoWindowOverlay
          position={hoveredZone.position}
          content={`<div style="font-size:12px;min-width:160px"><div style="font-weight:600">${hoveredZone.name}</div><div style="color:#9ca3af;text-transform:capitalize">${hoveredZone.category.replace(/-/g, " ")}</div><div style="color:${hoveredZone.severity === "prohibited" ? "#f87171" : "#fb923c"};font-weight:600">${hoveredZone.severity === "prohibited" ? "Prohibited" : "Restricted"}</div></div>`}
          onClose={() => setHoveredZone(null)}
        />
      )}
    </>
  );
}

function MapInteraction({
  targetTilt,
  templateMode,
  dragState,
  setDragState,
  rawPath,
  setRawPath,
  setOrbitParams,
  setGridParams,
  setFacadeParams,
  setPencilParams,
  setTemplateConfirmed,
  rnbSelectionEnabled,
  rnbBuildings,
  onSelectRnbBuilding,
  onClearRnbSelection,
}: {
  targetTilt: number;
  templateMode: TemplateMode;
  dragState: { start: [number, number]; end: [number, number] } | null;
  setDragState: (
    state: { start: [number, number]; end: [number, number] } | null,
  ) => void;
  rawPath: [number, number][];
  setRawPath: (path: [number, number][]) => void;
  setOrbitParams: (value: OrbitParams | null) => void;
  setGridParams: (value: GridParams | null) => void;
  setFacadeParams: (value: FacadeParams | null) => void;
  setPencilParams: (value: PencilParams | null) => void;
  setTemplateConfirmed: (value: boolean) => void;
  rnbSelectionEnabled: boolean;
  rnbBuildings: RnbBuilding[];
  onSelectRnbBuilding: (
    building: RnbBuilding,
    position: google.maps.LatLngLiteral,
  ) => void;
  onClearRnbSelection: () => void;
}) {
  const map = useMap();
  const isAddingWaypoint = useMissionStore((s) => s.isAddingWaypoint);
  const isAddingPoi = useMissionStore((s) => s.isAddingPoi);
  const isDrawingObstacle = useMissionStore((s) => s.isDrawingObstacle);
  const drawingVertices = useMissionStore((s) => s.drawingVertices);
  const addWaypoint = useMissionStore((s) => s.addWaypoint);
  const addPoi = useMissionStore((s) => s.addPoi);
  const addObstacle = useMissionStore((s) => s.addObstacle);
  const setDrawingVertices = useMissionStore((s) => s.setDrawingVertices);
  const setIsDrawingObstacle = useMissionStore((s) => s.setIsDrawingObstacle);

  useEffect(() => {
    if (!map) return;
    map.setTilt(targetTilt);
    if (targetTilt === 0) {
      map.setHeading(0);
    }
    map.setOptions({
      tiltInteractionEnabled: targetTilt > 0,
      headingInteractionEnabled: targetTilt > 0,
    });
  }, [map, targetTilt]);

  useEffect(() => {
    if (!map) return;

    const handleClick = map.addListener(
      "click",
      (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return;
        const point: [number, number] = [
          event.latLng.lat(),
          event.latLng.lng(),
        ];

        if (
          templateMode === "orbit" ||
          templateMode === "grid" ||
          templateMode === "facade"
        ) {
          if (!dragState) {
            setDragState({ start: point, end: point });
            return;
          }

          const nextState = { start: dragState.start, end: point };
          const distance = haversine(
            nextState.start[0],
            nextState.start[1],
            nextState.end[0],
            nextState.end[1],
          );
          if (distance < 5) return;

          if (templateMode === "orbit") {
            setOrbitParams({
              ...DEFAULT_ORBIT_PARAMS,
              center: nextState.start,
              radiusM: Math.round(distance),
            });
          } else if (templateMode === "grid") {
            setGridParams({
              ...DEFAULT_GRID_PARAMS,
              corner1: nextState.start,
              corner2: nextState.end,
            });
          } else {
            setFacadeParams({
              ...DEFAULT_FACADE_PARAMS,
              point1: nextState.start,
              point2: nextState.end,
            });
          }

          setTemplateConfirmed(true);
          setDragState(nextState);
          return;
        }

        if (templateMode === "pencil") {
          setRawPath([...rawPath, point]);
          return;
        }

        if (isDrawingObstacle) {
          if (drawingVertices.length >= 3) {
            const [firstLat, firstLng] = drawingVertices[0];
            if (haversine(firstLat, firstLng, point[0], point[1]) < 5) {
              addObstacle(drawingVertices);
              return;
            }
          }
          setDrawingVertices([...drawingVertices, point]);
          return;
        }

        if (rnbSelectionEnabled) {
          const selectedBuilding = findSelectableRnbBuilding(
            { lat: point[0], lng: point[1] },
            rnbBuildings,
          );

          if (selectedBuilding) {
            onSelectRnbBuilding(selectedBuilding, {
              lat: point[0],
              lng: point[1],
            });
            return;
          }
        }

        if (isAddingWaypoint) {
          addWaypoint(point[0], point[1]);
          return;
        }

        if (isAddingPoi) {
          addPoi(point[0], point[1]);
          return;
        }

        if (rnbSelectionEnabled) {
          onClearRnbSelection();
        }
      },
    );

    const handleMouseMove = map.addListener(
      "mousemove",
      (event: google.maps.MapMouseEvent) => {
        if (
          !event.latLng ||
          !dragState ||
          !(
            templateMode === "orbit" ||
            templateMode === "grid" ||
            templateMode === "facade"
          )
        ) {
          return;
        }
        setDragState({
          start: dragState.start,
          end: [event.latLng.lat(), event.latLng.lng()],
        });
      },
    );

    const handleDoubleClick = map.addListener("dblclick", () => {
      if (templateMode === "pencil" && rawPath.length >= 2) {
        if (pathLength(rawPath) >= MIN_PENCIL_PATH_LENGTH_M) {
          setPencilParams({ ...DEFAULT_PENCIL_PARAMS, path: rawPath });
          setTemplateConfirmed(true);
        }
        return;
      }

      if (isDrawingObstacle && drawingVertices.length >= 3) {
        addObstacle(drawingVertices);
      }
    });

    return () => {
      handleClick.remove();
      handleMouseMove.remove();
      handleDoubleClick.remove();
    };
  }, [
    map,
    templateMode,
    dragState,
    rawPath,
    setRawPath,
    setDragState,
    setOrbitParams,
    setGridParams,
    setFacadeParams,
    setPencilParams,
    setTemplateConfirmed,
    isAddingWaypoint,
    isAddingPoi,
    isDrawingObstacle,
    drawingVertices,
    addWaypoint,
    addPoi,
    addObstacle,
    setDrawingVertices,
    rnbSelectionEnabled,
    rnbBuildings,
    onSelectRnbBuilding,
    onClearRnbSelection,
  ]);

  useEffect(() => {
    if (!isDrawingObstacle) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawingVertices([]);
        setIsDrawingObstacle(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDrawingObstacle, setDrawingVertices, setIsDrawingObstacle]);

  return null;
}

export function MapView() {
  const googleMapsApiKey = useConfigStore((s) => s.googleMapsApiKey);
  const defaultMapView = useConfigStore((s) => s.defaultMapView);
  const waypoints = useMissionStore((s) => s.waypoints);
  const pois = useMissionStore((s) => s.pois);
  const obstacles = useMissionStore((s) => s.obstacles);
  const selectedWaypointIndices = useMissionStore(
    (s) => s.selectedWaypointIndices,
  );
  const selectedPoiId = useMissionStore((s) => s.selectedPoiId);
  const selectedObstacleId = useMissionStore((s) => s.selectedObstacleId);
  const drawingVertices = useMissionStore((s) => s.drawingVertices);
  const templateMode = useMissionStore((s) => s.templateMode);
  const moveWaypoint = useMissionStore((s) => s.moveWaypoint);
  const selectWaypoint = useMissionStore((s) => s.selectWaypoint);
  const movePoi = useMissionStore((s) => s.movePoi);
  const selectPoi = useMissionStore((s) => s.selectPoi);
  const updateWaypoint = useMissionStore((s) => s.updateWaypoint);
  const moveObstacleVertex = useMissionStore((s) => s.moveObstacleVertex);
  const addObstacleVertex = useMissionStore((s) => s.addObstacleVertex);
  const removeObstacleVertex = useMissionStore((s) => s.removeObstacleVertex);
  const selectObstacle = useMissionStore((s) => s.selectObstacle);
  const addObstacle = useMissionStore((s) => s.addObstacle);
  const appendWaypoints = useMissionStore((s) => s.appendWaypoints);
  const setDrawingVertices = useMissionStore((s) => s.setDrawingVertices);
  const setIsDrawingObstacle = useMissionStore((s) => s.setIsDrawingObstacle);
  const setTemplateMode = useMissionStore((s) => s.setTemplateMode);
  const vizPrefs = usePreferencesStore((s) => s.preferences?.visualization);

  const [mapTypeId, setMapTypeId] =
    useState<google.maps.MapTypeId>(ROADMAP_TYPE);
  const [is3D, setIs3D] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [dragState, setDragState] = useState<{
    start: [number, number];
    end: [number, number];
  } | null>(null);
  const [rawPath, setRawPath] = useState<[number, number][]>([]);
  const [templateConfirmed, setTemplateConfirmed] = useState(false);
  const [orbitParams, setOrbitParams] = useState<OrbitParams | null>(null);
  const [gridParams, setGridParams] = useState<GridParams | null>(null);
  const [facadeParams, setFacadeParams] = useState<FacadeParams | null>(null);
  const [pencilParams, setPencilParams] = useState<PencilParams | null>(null);
  const [detectedBuilding, setDetectedBuilding] =
    useState<DetectedBuilding | null>(null);
  const [detectedBuildingCandidates, setDetectedBuildingCandidates] = useState<
    DetectedBuilding[]
  >([]);
  const [facadeAssistSeedParams, setFacadeAssistSeedParams] =
    useState<FacadeParams | null>(null);
  const [facadeSegmentOptions, setFacadeSegmentOptions] = useState<
    FacadeSegmentOption[]
  >([]);
  const [selectedFacadeSegmentId, setSelectedFacadeSegmentId] = useState<
    string | null
  >(null);
  const [facadeVariantOptions, setFacadeVariantOptions] = useState<
    FacadeVariantOption[]
  >([]);
  const [selectedFacadeVariantId, setSelectedFacadeVariantId] = useState<
    string | null
  >(null);
  const [facadeObjective, setFacadeObjective] =
    useState<FacadeCopilotObjective>("balanced");
  const [facadeAssistBusy, setFacadeAssistBusy] = useState(false);
  const [facadeAssistMessage, setFacadeAssistMessage] = useState<string | null>(
    null,
  );
  const [facadeRecommendation, setFacadeRecommendation] =
    useState<FacadeCopilotRecommendation | null>(null);
  const [facadeRecommendationBusy, setFacadeRecommendationBusy] =
    useState(false);
  const [showRnbLayer, setShowRnbLayer] = useState(false);
  const [rnbBuildings, setRnbBuildings] = useState<RnbBuilding[]>([]);
  const [selectedRnbBuilding, setSelectedRnbBuilding] =
    useState<SelectedRnbBuilding | null>(null);
  const [showSelectedRnbInfo, setShowSelectedRnbInfo] = useState(false);
  const [showSelectedBuildingScanPanel, setShowSelectedBuildingScanPanel] =
    useState(false);
  const [selectedBdTopoBuilding, setSelectedBdTopoBuilding] =
    useState<BdTopoMatchedBuilding | null>(null);
  const [, setSelectedBdnbBuilding] = useState<BdnbBuildingEnrichment | null>(
    null,
  );
  const [selectedRnbBuildingLoading, setSelectedRnbBuildingLoading] =
    useState(false);
  const [selectedBuildingScanMode, setSelectedBuildingScanMode] =
    useState<BuildingScanMode>("reconstruction-3d");
  const [selectedBuildingScanVariantId, setSelectedBuildingScanVariantId] =
    useState<string>("balanced");
  const [streetViewContext, setStreetViewContext] =
    useState<StreetViewContext | null>(null);
  const [mainMapViewport, setMainMapViewport] =
    useState<MainMapViewport | null>(null);
  const programmaticTemplateModeRef = useRef<TemplateMode>(null);
  const reconstructionDemoLaunchedRef = useRef(false);
  const buildingDetectionCacheRef = useRef<BuildingDetectionCacheEntry[]>(
    loadBuildingDetectionCache(),
  );
  const buildings3DFallbackQueryRef = useRef<{
    lat: number;
    lng: number;
    zoom: number;
  } | null>(null);

  const reconstructionDemoMode = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("demo") === RECONSTRUCTION_DEMO_QUERY
      ? RECONSTRUCTION_DEMO_QUERY
      : null;
  }, []);

  const warnings = useMemo(
    () => getObstacleWarnings(waypoints, obstacles),
    [waypoints, obstacles],
  );
  const warningSegments = useMemo(() => {
    const indexes = new Set<number>();
    for (const warning of warnings) {
      if (warning.type === "crosses") indexes.add(warning.waypointIndex);
    }
    return indexes;
  }, [warnings]);

  const waypointHeadings = useMemo(
    () =>
      waypoints.map((waypoint) => ({
        waypoint,
        heading: resolveWaypointHeading(waypoint, pois),
      })),
    [waypoints, pois],
  );

  const singleSelectedWaypoint = useMemo(() => {
    if (selectedWaypointIndices.size !== 1) return null;
    const [selectedIndex] = [...selectedWaypointIndices];
    return (
      waypoints.find((waypoint) => waypoint.index === selectedIndex) ?? null
    );
  }, [selectedWaypointIndices, waypoints]);

  const frustumCorners = useMemo(() => {
    if (!singleSelectedWaypoint) return null;
    return computePlaneCorners(
      singleSelectedWaypoint.latitude,
      singleSelectedWaypoint.longitude,
      singleSelectedWaypoint.height,
      resolveWaypointHeading(singleSelectedWaypoint, pois),
      singleSelectedWaypoint.gimbalPitchAngle,
    );
  }, [singleSelectedWaypoint, pois]);

  const selectedFacadeSegment = useMemo(
    () =>
      facadeSegmentOptions.find(
        (segment) => segment.id === selectedFacadeSegmentId,
      ) ??
      facadeSegmentOptions[0] ??
      null,
    [facadeSegmentOptions, selectedFacadeSegmentId],
  );

  const selectedBuildingFacadeSegments = useMemo(() => {
    if (!selectedRnbBuilding) {
      return [] as FacadeSegmentOption[];
    }

    const footprint =
      selectedBdTopoBuilding?.footprint ??
      selectedRnbBuilding.building.footprint;
    const fallbackStart = footprint[0];
    const fallbackEnd = footprint[1] ?? footprint[0];

    return rankFacadeSegments(footprint, fallbackStart, fallbackEnd);
  }, [selectedBdTopoBuilding, selectedRnbBuilding]);

  const selectedBuildingDetected = useMemo(() => {
    if (!selectedRnbBuilding) {
      return null;
    }

    return toDetectedBuildingFromRnb(
      selectedRnbBuilding.building,
      selectedBdTopoBuilding,
    );
  }, [selectedBdTopoBuilding, selectedRnbBuilding]);

  const selectedBuildingHeightM = useMemo(() => {
    if (!selectedRnbBuilding) {
      return null;
    }

    return estimatedBuildingHeightM(
      selectedRnbBuilding.building,
      selectedBdTopoBuilding,
    );
  }, [selectedBdTopoBuilding, selectedRnbBuilding]);

  const buildingScanVariants = useMemo<BuildingScanVariantOption[]>(() => {
    if (selectedBuildingScanMode === "reconstruction-3d") {
      return [
        {
          id: "building-3d-default",
          label: "Photogrammétrie 3D",
          detail: "Grille oblique + toit + orbite",
          description:
            "Prépare un plan de vol de reconstruction 3D pour le bâtiment sélectionné.",
        },
      ];
    }

    return [
      {
        id: "balanced",
        label: "Façades standard",
        detail: "Couverture équilibrée",
        description:
          "Scanne chaque façade une à une avec une densité adaptée à l’inspection générale.",
      },
      {
        id: "dense",
        label: "Façades denses",
        detail: "Photogrammétrie plus serrée",
        description:
          "Ajoute plus de lignes et colonnes sur chaque façade pour une couverture plus dense.",
      },
    ];
  }, [selectedBuildingScanMode]);

  const selectedBuildingScanVariant = useMemo(
    () =>
      buildingScanVariants.find(
        (variant) => variant.id === selectedBuildingScanVariantId,
      ) ??
      buildingScanVariants[0] ??
      null,
    [buildingScanVariants, selectedBuildingScanVariantId],
  );

  const selectedBuildingScanPreview =
    useMemo<BuildingScanPreview | null>(() => {
      if (
        !selectedRnbBuilding ||
        !selectedBuildingDetected ||
        !selectedBuildingHeightM
      ) {
        return null;
      }

      if (selectedBuildingScanMode === "reconstruction-3d") {
        const mission = generateBuildingReconstructionMission({
          building: selectedBuildingDetected,
          selectedSegment: selectedBuildingFacadeSegments[0] ?? null,
        });

        if (!mission || mission.waypoints.length === 0) {
          return null;
        }

        return {
          mission,
          label: "Aperçu reconstruction 3D bâtiment",
        };
      }

      if (selectedBuildingFacadeSegments.length === 0) {
        return null;
      }

      const mission = generateFacadeMissionForAllSegments({
        segments: selectedBuildingFacadeSegments,
        heightM: selectedBuildingHeightM,
        density:
          selectedBuildingScanVariant?.id === "dense" ? "dense" : "standard",
      });

      if (mission.waypoints.length === 0) {
        return null;
      }

      return {
        mission,
        label: "Aperçu scan des façades",
      };
    }, [
      selectedBuildingDetected,
      selectedBuildingFacadeSegments,
      selectedBuildingHeightM,
      selectedBuildingScanMode,
      selectedBuildingScanVariant,
      selectedRnbBuilding,
    ]);

  const reconstructionPresets = useMemo(
    () =>
      detectedBuilding
        ? buildReconstructionPresets(detectedBuilding, selectedFacadeSegment)
        : [],
    [detectedBuilding, selectedFacadeSegment],
  );

  const templatePreview = useMemo<TemplateResult | null>(() => {
    if (orbitParams) return generateOrbit(orbitParams);
    if (gridParams) return generateGrid(gridParams);
    if (facadeParams) return generateFacade(facadeParams);
    if (pencilParams) return generatePencil(pencilParams);
    return null;
  }, [orbitParams, gridParams, facadeParams, pencilParams]);

  const activeTemplateType: TemplateMode = orbitParams
    ? "orbit"
    : gridParams
      ? "grid"
      : facadeParams
        ? "facade"
        : pencilParams
          ? "pencil"
          : null;

  const mapPreview = activeTemplateType
    ? templatePreview
    : showSelectedBuildingScanPanel
      ? (selectedBuildingScanPreview?.mission ?? null)
      : null;

  const mapPreviewLabel = activeTemplateType
    ? `Current ${activeTemplateType} template`
    : showSelectedBuildingScanPanel
      ? (selectedBuildingScanPreview?.label ?? null)
      : null;

  const buildings3DView = useMemo(
    () =>
      buildBuildings3DView({
        templatePreview,
        activeTemplateType,
        detectedBuilding,
        selectedSegment: selectedFacadeSegment,
        facadeParams,
        selectedWaypoint: singleSelectedWaypoint,
        selectedWaypointHeading: singleSelectedWaypoint
          ? resolveWaypointHeading(singleSelectedWaypoint, pois)
          : null,
        mainMapViewport,
        defaultMapView,
      }),
    [
      activeTemplateType,
      defaultMapView,
      detectedBuilding,
      facadeParams,
      mainMapViewport,
      pois,
      selectedFacadeSegment,
      singleSelectedWaypoint,
      templatePreview,
    ],
  );

  const reconstructionShell = useMemo(
    () =>
      buildApproximateBuildingShell(
        detectedBuilding,
        selectedFacadeSegment,
        streetViewContext,
      ),
    [detectedBuilding, selectedFacadeSegment, streetViewContext],
  );

  const buildings3DMarkers = useMemo(
    () =>
      buildBuildings3DMarkers({
        detectedBuilding,
        selectedSegment: selectedFacadeSegment,
        facadeRecommendation,
        streetViewContext,
      }),
    [
      detectedBuilding,
      facadeRecommendation,
      selectedFacadeSegment,
      streetViewContext,
    ],
  );

  const selectedRnbCentroidPosition = useMemo<LatLng | null>(() => {
    if (!selectedRnbBuilding) {
      return null;
    }

    return (
      selectedBdTopoBuilding?.centroid ?? selectedRnbBuilding.building.point
    );
  }, [selectedBdTopoBuilding, selectedRnbBuilding]);

  const clearSelectedBuildingUi = useCallback(() => {
    setSelectedRnbBuilding(null);
    setShowSelectedRnbInfo(false);
    setShowSelectedBuildingScanPanel(false);
    setSelectedBdTopoBuilding(null);
    setSelectedBdnbBuilding(null);
    setSelectedRnbBuildingLoading(false);
  }, []);

  const contextShells = useMemo(() => {
    if (!showRnbLayer && !detectedBuilding) {
      return [] as Array<{ id: string; shell: ReconstructedBuildingShell }>;
    }

    return detectedBuildingCandidates
      .filter((candidate) => candidate.id !== detectedBuilding?.id)
      .map((candidate) => ({
        id: candidate.id,
        shell: buildApproximateBuildingShell(candidate, null, null),
      }))
      .filter(
        (
          candidate,
        ): candidate is { id: string; shell: ReconstructedBuildingShell } =>
          candidate.shell !== null,
      );
  }, [detectedBuilding, detectedBuildingCandidates, showRnbLayer]);

  const scanRoute3D = useMemo<Buildings3DScanRoute | null>(() => {
    const previewWaypoints = mapPreview?.waypoints ?? [];
    const routeWaypoints =
      previewWaypoints.length > 0 ? previewWaypoints : waypoints;

    if (routeWaypoints.length === 0) return null;

    return {
      title:
        previewWaypoints.length > 0 && mapPreviewLabel
          ? mapPreviewLabel
          : "Current mission route",
      path: routeWaypoints.map((waypoint) => ({
        lat: waypoint.latitude,
        lng: waypoint.longitude,
        altitude: Math.max(0, waypoint.height),
      })),
      waypointMarkers: routeWaypoints.map((waypoint, index) => ({
        id: `scan-waypoint-${index + 1}`,
        position: {
          lat: waypoint.latitude,
          lng: waypoint.longitude,
          altitude: Math.max(0, waypoint.height),
        },
        glyph: String(index + 1),
        label: `Waypoint ${index + 1}`,
        background: "#f59e0b",
        borderColor: "#fde68a",
        glyphColor: "#431407",
        scale: 0.92,
      })),
    };
  }, [mapPreview, mapPreviewLabel, waypoints]);

  useEffect(() => {
    if (!showRnbLayer) {
      setRnbBuildings([]);
      clearSelectedBuildingUi();
    }
  }, [clearSelectedBuildingUi, showRnbLayer]);

  useEffect(() => {
    setSelectedBuildingScanVariantId(
      selectedBuildingScanMode === "reconstruction-3d"
        ? "building-3d-default"
        : "balanced",
    );
  }, [selectedBuildingScanMode]);

  useEffect(() => {
    if (!selectedRnbBuilding) {
      setShowSelectedRnbInfo(false);
      setShowSelectedBuildingScanPanel(false);
      setSelectedBdTopoBuilding(null);
      setSelectedBdnbBuilding(null);
      setSelectedRnbBuildingLoading(false);
      return;
    }

    let cancelled = false;
    const currentBuilding = selectedRnbBuilding.building;
    setDetectedBuilding(toDetectedBuildingFromRnb(currentBuilding));
    setSelectedRnbBuildingLoading(true);

    void (async () => {
      const [bdTopoResult, bdnbResult] = await Promise.allSettled([
        buildingApi.matchBdTopoBuilding({
          rnbId: currentBuilding.rnbId,
          bdTopoId: currentBuilding.bdTopoId,
        }),
        buildingApi.enrichBdnbBuilding({
          rnbId: currentBuilding.rnbId,
        }),
      ]);

      if (cancelled) {
        return;
      }

      const bdTopoBuilding =
        bdTopoResult.status === "fulfilled"
          ? bdTopoResult.value.building
          : null;
      const bdnbBuilding =
        bdnbResult.status === "fulfilled" ? bdnbResult.value.building : null;

      setSelectedBdTopoBuilding(bdTopoBuilding);
      setSelectedBdnbBuilding(bdnbBuilding);

      if (bdTopoBuilding) {
        setDetectedBuilding(
          toDetectedBuildingFromRnb(currentBuilding, bdTopoBuilding),
        );
      }

      setSelectedRnbBuildingLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRnbBuilding]);

  useEffect(() => {
    let cancelled = false;

    if (!detectedBuilding) {
      setStreetViewContext(null);
      return;
    }

    void resolveStreetViewContext(detectedBuilding, selectedFacadeSegment).then(
      (context) => {
        if (!cancelled) {
          setStreetViewContext(context);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [detectedBuilding, selectedFacadeSegment]);

  useEffect(() => {
    if (!is3D || !showRnbLayer || !mainMapViewport || detectedBuilding) {
      return;
    }

    const lastQuery = buildings3DFallbackQueryRef.current;
    if (
      lastQuery &&
      haversine(
        lastQuery.lat,
        lastQuery.lng,
        mainMapViewport.center.lat,
        mainMapViewport.center.lng,
      ) < 45 &&
      Math.abs(lastQuery.zoom - mainMapViewport.zoom) < 0.35
    ) {
      return;
    }

    buildings3DFallbackQueryRef.current = {
      lat: mainMapViewport.center.lat,
      lng: mainMapViewport.center.lng,
      zoom: mainMapViewport.zoom,
    };

    let cancelled = false;
    const queryCenter = {
      lat: mainMapViewport.center.lat,
      lng: mainMapViewport.center.lng,
    };
    const radiusM = clamp(220 - mainMapViewport.zoom * 8, 70, 180);

    void (async () => {
      try {
        const response = await buildingApi.detectNearest({
          lat: queryCenter.lat,
          lng: queryCenter.lng,
          radiusM,
        });

        rememberBuildingDetection(
          buildingDetectionCacheRef,
          queryCenter,
          radiusM,
          response,
        );

        if (!cancelled) {
          setDetectedBuildingCandidates(response.candidates);
        }
      } catch {
        const cachedResponse = findCachedBuildingDetection(
          buildingDetectionCacheRef,
          queryCenter,
          radiusM,
        );

        if (!cancelled) {
          setDetectedBuildingCandidates(cachedResponse?.candidates ?? []);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [detectedBuilding, is3D, mainMapViewport, showRnbLayer]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") {
        setCtrlHeld(event.type === "keydown");
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", handler);
    };
  }, []);

  const resetTemplateState = useCallback(() => {
    setDragState(null);
    setRawPath([]);
    setTemplateConfirmed(false);
    setOrbitParams(null);
    setGridParams(null);
    setFacadeParams(null);
    setPencilParams(null);
    setDetectedBuilding(null);
    setDetectedBuildingCandidates([]);
    setFacadeAssistSeedParams(null);
    setFacadeSegmentOptions([]);
    setSelectedFacadeSegmentId(null);
    setFacadeVariantOptions([]);
    setSelectedFacadeVariantId(null);
    setFacadeAssistBusy(false);
    setFacadeAssistMessage(null);
    setFacadeRecommendation(null);
    setFacadeRecommendationBusy(false);
    setStreetViewContext(null);
  }, []);

  const clearTransientMapUi = useCallback(() => {
    resetTemplateState();
    clearSelectedBuildingUi();
  }, [clearSelectedBuildingUi, resetTemplateState]);

  const applyFacadeScenario = useCallback(
    (
      building: DetectedBuilding,
      seedParams: FacadeParams,
      segmentId?: string | null,
      variantId?: string | null,
    ) => {
      const scenario = buildFacadeScenario(
        seedParams,
        building,
        segmentId,
        variantId,
      );
      if (!scenario) return null;

      setDetectedBuilding(building);
      setFacadeAssistSeedParams(seedParams);
      setFacadeSegmentOptions(scenario.segments);
      setSelectedFacadeSegmentId(scenario.selectedSegment.id);
      setFacadeVariantOptions(scenario.variants);
      setSelectedFacadeVariantId(scenario.selectedVariant.id);
      setFacadeParams(scenario.selectedVariant.params);
      setTemplateConfirmed(true);

      return scenario;
    },
    [],
  );

  const refreshFacadeRecommendation = useCallback(
    async (
      building: DetectedBuilding,
      scenario: NonNullable<ReturnType<typeof buildFacadeScenario>>,
    ) => {
      setFacadeRecommendationBusy(true);
      try {
        const recommendation = await buildingApi.recommendFacadeScan({
          objective: facadeObjective,
          currentVariantId: scenario.selectedVariant.id,
          building: {
            id: building.id,
            estimatedHeightM: building.estimatedHeightM,
            source: building.source,
            distanceToQueryM: building.distanceToQueryM,
          },
          selectedSegment: {
            id: scenario.selectedSegment.id,
            label: scenario.selectedSegment.label,
            lengthM: scenario.selectedSegment.lengthM,
            distanceToHintM: scenario.selectedSegment.distanceToHintM,
            angleDeltaDeg: scenario.selectedSegment.angleDeltaDeg,
            score: scenario.selectedSegment.score,
          },
          variants: scenario.variants.map((variant) => ({
            id: variant.id,
            label: variant.label,
            score: variant.score,
            detail: variant.detail,
            params: {
              distanceM: variant.params.distanceM,
              minAltitude: variant.params.minAltitude,
              maxAltitude: variant.params.maxAltitude,
              numRows: variant.params.numRows,
              numColumns: variant.params.numColumns,
            },
          })),
        });
        setFacadeRecommendation(recommendation);
        return recommendation;
      } catch {
        setFacadeRecommendation(null);
        return null;
      } finally {
        setFacadeRecommendationBusy(false);
      }
    },
    [facadeObjective],
  );

  const runFacadeAssistFromParams = useCallback(
    async (
      seedParams: FacadeParams,
      options?: {
        openBuildings3D?: boolean;
        messagePrefix?: string;
        useDemoFallback?: boolean;
      },
    ) => {
      const lat = (seedParams.point1[0] + seedParams.point2[0]) / 2;
      const lng = (seedParams.point1[1] + seedParams.point2[1]) / 2;
      const queryCenter = { lat, lng };
      const radiusM = Math.max(60, seedParams.distanceM * 4);

      setFacadeAssistBusy(true);
      setFacadeAssistMessage("Searching for the nearest building footprint...");

      try {
        let response;
        try {
          response = await buildingApi.detectNearest({
            lat,
            lng,
            radiusM,
          });

          rememberBuildingDetection(
            buildingDetectionCacheRef,
            queryCenter,
            radiusM,
            response,
          );
        } catch (error) {
          const cachedResponse = findCachedBuildingDetection(
            buildingDetectionCacheRef,
            queryCenter,
            radiusM,
          );

          if (cachedResponse) {
            response = cachedResponse;
          } else if (!options?.useDemoFallback) {
            throw error;
          } else {
            response = {
              building: RECONSTRUCTION_DEMO_BUILDING,
              candidates: [RECONSTRUCTION_DEMO_BUILDING],
            };
          }
        }

        setDetectedBuildingCandidates(response.candidates);
        const scenario = applyFacadeScenario(response.building, seedParams);
        if (!scenario) {
          throw new Error("Detected building has no usable facade segment");
        }

        const recommendation = await refreshFacadeRecommendation(
          response.building,
          scenario,
        );

        if (options?.openBuildings3D) {
          setIs3D(true);
        }

        const prefix = options?.messagePrefix
          ? `${options.messagePrefix} `
          : "";
        setFacadeAssistMessage(
          recommendation
            ? `${prefix}${response.building.source.toUpperCase()} footprint detected. Copilot recommends ${recommendation.recommendedVariantLabel.toLowerCase()} at ${Math.round(recommendation.confidence * 100)}% confidence.`
            : `${prefix}${response.building.source.toUpperCase()} footprint detected, ${scenario.segments.length} facades ranked, ${scenario.selectedVariant.label.toLowerCase()} variant selected at ${(scenario.selectedVariant.score * 100).toFixed(0)}%.`,
        );

        return { response, scenario, recommendation };
      } catch (error) {
        setDetectedBuilding(null);
        setDetectedBuildingCandidates([]);
        setFacadeSegmentOptions([]);
        setSelectedFacadeSegmentId(null);
        setFacadeVariantOptions([]);
        setSelectedFacadeVariantId(null);
        setFacadeRecommendation(null);
        setFacadeAssistMessage(
          error instanceof Error
            ? error.message
            : "Failed to auto-fit building",
        );
        return null;
      } finally {
        setFacadeAssistBusy(false);
      }
    },
    [applyFacadeScenario, refreshFacadeRecommendation],
  );

  const handleFacadeAssist = useCallback(async () => {
    if (!facadeParams) return;
    await runFacadeAssistFromParams(facadeParams);
  }, [facadeParams, runFacadeAssistFromParams]);

  const launchReconstructionDemo = useCallback(
    async (options?: { autoAssist?: boolean; openBuildings3D?: boolean }) => {
      const seedParams = { ...RECONSTRUCTION_DEMO_PRESET.facadeParams };

      programmaticTemplateModeRef.current = "facade";
      setTemplateMode("facade");
      setDragState(null);
      setRawPath([]);
      setOrbitParams(null);
      setGridParams(null);
      setPencilParams(null);
      setTemplateConfirmed(true);
      setFacadeParams(seedParams);
      setFacadeAssistSeedParams(seedParams);
      setDetectedBuilding(null);
      setDetectedBuildingCandidates([]);
      setFacadeSegmentOptions([]);
      setSelectedFacadeSegmentId(null);
      setFacadeVariantOptions([]);
      setSelectedFacadeVariantId(null);
      setFacadeRecommendation(null);
      setFacadeRecommendationBusy(false);
      setStreetViewContext(null);
      setFacadeObjective(RECONSTRUCTION_DEMO_PRESET.objective);
      setSearchValue(RECONSTRUCTION_DEMO_PRESET.searchLabel);
      setMapTypeId(HYBRID_TYPE);

      if (!options?.autoAssist) {
        setIs3D(false);
        setFacadeAssistMessage(
          "Reconstruction demo loaded. Click Building assist to complete the hybrid 3D preview.",
        );
        return;
      }

      await runFacadeAssistFromParams(seedParams, {
        openBuildings3D: options.openBuildings3D,
        messagePrefix: "Demo ready.",
        useDemoFallback: true,
      });
    },
    [runFacadeAssistFromParams, setTemplateMode],
  );

  useEffect(() => {
    if (programmaticTemplateModeRef.current === templateMode) {
      programmaticTemplateModeRef.current = null;
      return;
    }
    resetTemplateState();
  }, [templateMode, resetTemplateState]);

  useEffect(() => {
    if (
      reconstructionDemoMode !== RECONSTRUCTION_DEMO_QUERY ||
      reconstructionDemoLaunchedRef.current
    ) {
      return;
    }

    reconstructionDemoLaunchedRef.current = true;
    void launchReconstructionDemo({ autoAssist: true, openBuildings3D: true });
  }, [launchReconstructionDemo, reconstructionDemoMode]);

  useEffect(() => {
    if (
      reconstructionDemoMode !== RECONSTRUCTION_DEMO_QUERY ||
      !reconstructionDemoLaunchedRef.current ||
      !mainMapViewport ||
      !facadeParams ||
      !templateConfirmed
    ) {
      return;
    }

    setIs3D(true);
  }, [
    facadeParams,
    is3D,
    mainMapViewport,
    reconstructionDemoMode,
    templateConfirmed,
  ]);

  const handleReconstructionPresetSelect = useCallback(
    (presetId: string) => {
      const preset = reconstructionPresets.find((item) => item.id === presetId);
      if (!preset) return;

      programmaticTemplateModeRef.current = preset.templateType;
      setDragState(null);
      setRawPath([]);
      setTemplateConfirmed(true);
      setDetectedBuilding(null);
      setDetectedBuildingCandidates([]);
      setFacadeAssistSeedParams(null);
      setFacadeSegmentOptions([]);
      setSelectedFacadeSegmentId(null);
      setFacadeVariantOptions([]);
      setSelectedFacadeVariantId(null);
      setFacadeAssistBusy(false);
      setFacadeRecommendation(null);
      setFacadeRecommendationBusy(false);
      setStreetViewContext(null);

      if (preset.templateType === "grid" && preset.gridParams) {
        setOrbitParams(null);
        setFacadeParams(null);
        setPencilParams(null);
        setGridParams(preset.gridParams);
      } else if (preset.templateType === "facade" && preset.facadeParams) {
        setOrbitParams(null);
        setGridParams(null);
        setPencilParams(null);
        setFacadeParams(preset.facadeParams);
      } else if (preset.templateType === "orbit" && preset.orbitParams) {
        setGridParams(null);
        setFacadeParams(null);
        setPencilParams(null);
        setOrbitParams(preset.orbitParams);
      }

      setTemplateMode(preset.templateType);
    },
    [reconstructionPresets, setTemplateMode],
  );

  const handleSelectedBuildingScanApply = useCallback(() => {
    if (
      !selectedRnbBuilding ||
      !selectedBuildingDetected ||
      !selectedBuildingHeightM
    ) {
      toast.error("Aucun bâtiment sélectionné exploitable.");
      return;
    }

    if (selectedBuildingScanMode === "reconstruction-3d") {
      const mission = generateBuildingReconstructionMission({
        building: selectedBuildingDetected,
        selectedSegment: selectedBuildingFacadeSegments[0] ?? null,
      });

      if (!mission || mission.waypoints.length === 0) {
        toast.error("Impossible de générer le plan de vol 3D du bâtiment.");
        return;
      }

      appendWaypoints(mission.waypoints, mission.pois);
      toast.success(
        `${mission.waypoints.length} waypoints ajoutés pour la reconstruction 3D du bâtiment.`,
      );
      return;
    }

    if (selectedBuildingFacadeSegments.length === 0) {
      toast.error("Aucune façade exploitable n’a été trouvée.");
      return;
    }

    const mission = generateFacadeMissionForAllSegments({
      segments: selectedBuildingFacadeSegments,
      heightM: selectedBuildingHeightM,
      density:
        selectedBuildingScanVariant?.id === "dense" ? "dense" : "standard",
    });

    if (mission.waypoints.length === 0) {
      toast.error("Impossible de générer les waypoints de scan façade.");
      return;
    }

    appendWaypoints(mission.waypoints, mission.pois);
    toast.success(
      `${mission.waypoints.length} waypoints ajoutés pour ${selectedBuildingFacadeSegments.length} façades.`,
    );
  }, [
    appendWaypoints,
    selectedBuildingDetected,
    selectedBuildingFacadeSegments,
    selectedBuildingHeightM,
    selectedBuildingScanMode,
    selectedBuildingScanVariant,
    selectedRnbBuilding,
  ]);

  const handleSelectRnbBuilding = useCallback(
    (building: RnbBuilding, position: google.maps.LatLngLiteral) => {
      setSelectedRnbBuilding({ building, position });
      setShowSelectedRnbInfo(true);
    },
    [],
  );

  const handleClearSelectedBuilding = useCallback(() => {
    clearSelectedBuildingUi();
  }, [clearSelectedBuildingUi]);

  const openSelectedBuildingScanPanel = useCallback(() => {
    if (!selectedRnbBuilding) {
      toast.error("Sélectionnez d’abord un bâtiment.");
      return;
    }

    setShowSelectedBuildingScanPanel(true);
  }, [selectedRnbBuilding]);

  if (!googleMapsApiKey) {
    return (
      <div className="relative h-full w-full flex items-center justify-center bg-background text-muted-foreground">
        <p>
          Google Maps API key not configured. Add GOOGLE_MAPS_API_KEY or
          VITE_GOOGLE_MAPS_API_KEY to your environment.
        </p>
      </div>
    );
  }

  return (
    <APIProvider apiKey={googleMapsApiKey}>
      <div className="relative h-full w-full">
        <Map
          defaultCenter={{
            lat: defaultMapView.latitude,
            lng: defaultMapView.longitude,
          }}
          defaultZoom={defaultMapView.zoom}
          mapTypeId={mapTypeId}
          renderingType={RenderingType.VECTOR}
          defaultTilt={vizPrefs?.viewMode === "3d" ? 45 : 0}
          tiltInteractionEnabled={is3D}
          headingInteractionEnabled={is3D}
          disableDefaultUI
          disableDoubleClickZoom={
            templateMode !== null || drawingVertices.length > 0
          }
          gestureHandling="greedy"
          clickableIcons={false}
          reuseMaps
          style={{ width: "100%", height: "100%" }}
        >
          <RnbBuildingsLayer
            enabled={showRnbLayer}
            buildings={rnbBuildings}
            selectedBuildingId={selectedRnbBuilding?.building.rnbId ?? null}
            onBuildingsChange={setRnbBuildings}
            onSelectBuilding={handleSelectRnbBuilding}
          />
          <MapInteraction
            targetTilt={is3D ? (mapTypeId === HYBRID_TYPE ? 67.5 : 45) : 0}
            templateMode={templateMode}
            dragState={dragState}
            setDragState={setDragState}
            rawPath={rawPath}
            setRawPath={setRawPath}
            setOrbitParams={setOrbitParams}
            setGridParams={setGridParams}
            setFacadeParams={setFacadeParams}
            setPencilParams={setPencilParams}
            setTemplateConfirmed={setTemplateConfirmed}
            rnbSelectionEnabled={showRnbLayer}
            rnbBuildings={rnbBuildings}
            onSelectRnbBuilding={handleSelectRnbBuilding}
            onClearRnbSelection={handleClearSelectedBuilding}
          />
          <MainMapViewportSync onChange={setMainMapViewport} />
          <FitBoundsOnLoad />
          <AirspaceLayer />

          {waypoints.slice(0, -1).map((waypoint, index) => {
            const next = waypoints[index + 1];
            return (
              <PolylineOverlay
                key={`flight-${waypoint.index}-${next.index}`}
                path={[
                  toLatLng(waypoint.latitude, waypoint.longitude),
                  toLatLng(next.latitude, next.longitude),
                ]}
                strokeColor={
                  warningSegments.has(waypoint.index) ? "#ef4444" : "#3b82f6"
                }
                strokeOpacity={0}
                strokeWeight={3}
                icons={dashedIcon(
                  warningSegments.has(waypoint.index) ? "#ef4444" : "#3b82f6",
                )}
              />
            );
          })}

          {waypoints.map((waypoint) => {
            const targetPoi =
              waypoint.headingMode === "towardPOI" && waypoint.poiId
                ? pois.find((poi) => poi.id === waypoint.poiId)
                : null;
            if (!targetPoi) return null;
            return (
              <PolylineOverlay
                key={`poi-line-${waypoint.index}-${targetPoi.id}`}
                path={[
                  toLatLng(waypoint.latitude, waypoint.longitude),
                  toLatLng(targetPoi.latitude, targetPoi.longitude),
                ]}
                strokeColor="#4ade80"
                strokeOpacity={0}
                strokeWeight={2}
                icons={dashedIcon("#4ade80")}
              />
            );
          })}

          {waypointHeadings
            .filter(({ waypoint }) => hasExplicitHeading(waypoint))
            .map(({ waypoint, heading }) => (
              <PolylineOverlay
                key={`heading-${waypoint.index}`}
                path={headingPath(waypoint, heading)}
                strokeColor="#ef4444"
                strokeOpacity={
                  selectedWaypointIndices.has(waypoint.index) ? 0.85 : 0.45
                }
                strokeWeight={
                  selectedWaypointIndices.has(waypoint.index) ? 3 : 2
                }
                zIndex={selectedWaypointIndices.has(waypoint.index) ? 800 : 120}
              />
            ))}

          {singleSelectedWaypoint && frustumCorners && (
            <>
              <PolygonOverlay
                path={frustumCorners.map(([lat, lng]) => ({ lat, lng }))}
                strokeColor="#94a3b8"
                strokeOpacity={0.65}
                strokeWeight={2}
                fillColor="#94a3b8"
                fillOpacity={0.12}
                zIndex={140}
              />
              {frustumCorners.map(([lat, lng], index) => (
                <PolylineOverlay
                  key={`frustum-edge-${index}`}
                  path={[
                    toLatLng(
                      singleSelectedWaypoint.latitude,
                      singleSelectedWaypoint.longitude,
                    ),
                    { lat, lng },
                  ]}
                  strokeColor="#94a3b8"
                  strokeOpacity={0.55}
                  strokeWeight={2}
                  zIndex={130}
                />
              ))}
            </>
          )}

          {detectedBuilding && (
            <>
              <PolygonOverlay
                path={detectedBuilding.footprint.map((point) => ({
                  lat: point.lat,
                  lng: point.lng,
                }))}
                strokeColor="#14b8a6"
                strokeOpacity={0.8}
                strokeWeight={2}
                fillColor="#14b8a6"
                fillOpacity={0.08}
                zIndex={125}
              />
              {facadeSegmentOptions.map((segment) => {
                const isSelected = segment.id === selectedFacadeSegmentId;
                return (
                  <PolylineOverlay
                    key={segment.id}
                    path={[segment.start, segment.end]}
                    strokeColor={isSelected ? "#14b8a6" : "#f59e0b"}
                    strokeOpacity={isSelected ? 0.95 : 0.7}
                    strokeWeight={isSelected ? 5 : 3}
                    clickable
                    zIndex={isSelected ? 126 : 124}
                    onClick={() => {
                      const seed = facadeAssistSeedParams ?? facadeParams;
                      if (!seed) return;
                      const scenario = applyFacadeScenario(
                        detectedBuilding,
                        seed,
                        segment.id,
                        selectedFacadeVariantId,
                      );
                      if (!scenario) return;
                      setFacadeAssistMessage(
                        `${scenario.selectedSegment.label} selected, ${scenario.selectedVariant.label.toLowerCase()} variant at ${(scenario.selectedVariant.score * 100).toFixed(0)}%.`,
                      );
                    }}
                  />
                );
              })}
            </>
          )}

          {obstacles.map((obstacle) => {
            const isSelected = selectedObstacleId === obstacle.id;
            const path = obstaclePath(obstacle.vertices);
            const midpoints = isSelected
              ? obstacle.vertices.map((vertex, index) => {
                  const next =
                    obstacle.vertices[(index + 1) % obstacle.vertices.length];
                  return {
                    lat: (vertex[0] + next[0]) / 2,
                    lng: (vertex[1] + next[1]) / 2,
                    index,
                  };
                })
              : [];

            return (
              <div key={obstacle.id}>
                <PolygonOverlay
                  path={path}
                  strokeColor="#ef4444"
                  strokeWeight={isSelected ? 3 : 2}
                  fillColor="#ef4444"
                  fillOpacity={isSelected ? 0.18 : 0.12}
                  clickable
                  onClick={() => selectObstacle(obstacle.id)}
                />
                {isSelected &&
                  obstacle.vertices.map(([lat, lng], vertexIndex) => (
                    <MarkerOverlay
                      key={`${obstacle.id}-vertex-${vertexIndex}`}
                      position={{ lat, lng }}
                      fillColor="#ffffff"
                      strokeColor="#ef4444"
                      scale={6}
                      draggable
                      onDragEnd={(position) => {
                        moveObstacleVertex(
                          obstacle.id,
                          vertexIndex,
                          position.lat,
                          position.lng,
                        );
                      }}
                      onRightClick={() => {
                        if (obstacle.vertices.length > 3) {
                          removeObstacleVertex(obstacle.id, vertexIndex);
                        }
                      }}
                    />
                  ))}
                {isSelected &&
                  midpoints.map((midpoint) => (
                    <MarkerOverlay
                      key={`${obstacle.id}-mid-${midpoint.index}`}
                      position={{ lat: midpoint.lat, lng: midpoint.lng }}
                      fillColor="#fecaca"
                      strokeColor="#ef4444"
                      scale={4}
                      onClick={() => {
                        addObstacleVertex(
                          obstacle.id,
                          midpoint.index,
                          midpoint.lat,
                          midpoint.lng,
                        );
                      }}
                    />
                  ))}
              </div>
            );
          })}

          {drawingVertices.length >= 2 && (
            <PolylineOverlay
              path={drawingVertices.map(([lat, lng]) => ({ lat, lng }))}
              strokeColor="#ef4444"
              strokeOpacity={0}
              strokeWeight={2}
              icons={dashedIcon("#ef4444")}
            />
          )}

          {drawingVertices.length >= 3 && (
            <PolylineOverlay
              path={[
                {
                  lat: drawingVertices[drawingVertices.length - 1][0],
                  lng: drawingVertices[drawingVertices.length - 1][1],
                },
                { lat: drawingVertices[0][0], lng: drawingVertices[0][1] },
              ]}
              strokeColor="#ef4444"
              strokeOpacity={0}
              strokeWeight={2}
              icons={dashedIcon("#ef4444")}
            />
          )}

          {drawingVertices.map(([lat, lng], index) => (
            <MarkerOverlay
              key={`drawing-${index}`}
              position={{ lat, lng }}
              fillColor={index === 0 ? "#fca5a5" : "#ffffff"}
              strokeColor="#ef4444"
              scale={index === 0 ? 7 : 5}
            />
          ))}

          {waypoints.map((waypoint) => (
            <MarkerOverlay
              key={`waypoint-${waypoint.index}`}
              position={toLatLng(waypoint.latitude, waypoint.longitude)}
              title={`${waypoint.name}\nAlt: ${waypoint.height}m | Speed: ${waypoint.speed}m/s\nGimbal: ${waypoint.gimbalPitchAngle}°\n${waypoint.latitude.toFixed(6)}, ${waypoint.longitude.toFixed(6)}`}
              label={`${waypoint.index + 1}`}
              fillColor={
                selectedWaypointIndices.has(waypoint.index)
                  ? "#3b82f6"
                  : "#1e293b"
              }
              strokeColor={
                selectedWaypointIndices.has(waypoint.index)
                  ? "#93c5fd"
                  : "#64748b"
              }
              scale={10}
              draggable
              zIndex={selectedWaypointIndices.has(waypoint.index) ? 1000 : 100}
              onClick={(event) =>
                selectWaypoint(waypoint.index, selectionModeFromEvent(event))
              }
              onDragEnd={(position) =>
                moveWaypoint(waypoint.index, position.lat, position.lng)
              }
            />
          ))}

          {pois.map((poi) => (
            <MarkerOverlay
              key={`poi-${poi.id}`}
              position={toLatLng(poi.latitude, poi.longitude)}
              title={`${poi.name}\nHeight: ${poi.height}m${ctrlHeld && selectedWaypointIndices.size > 0 ? "\nCtrl+click to aim selected waypoints here" : ""}`}
              fillColor={selectedPoiId === poi.id ? "#ef4444" : "#dc2626"}
              strokeColor={selectedPoiId === poi.id ? "#fca5a5" : "#991b1b"}
              scale={9}
              iconPath="arrow"
              draggable
              zIndex={900}
              onClick={() => {
                if (ctrlHeld && selectedWaypointIndices.size > 0) {
                  for (const index of selectedWaypointIndices) {
                    updateWaypoint(index, {
                      headingMode: "towardPOI",
                      poiId: poi.id,
                      useGlobalHeadingParam: false,
                    });
                  }
                  return;
                }
                selectPoi(poi.id);
              }}
              onDragEnd={(position) =>
                movePoi(poi.id, position.lat, position.lng)
              }
            />
          ))}

          {dragState && !templateConfirmed && templateMode === "orbit" && (
            <PolylineOverlay
              path={circlePath(
                dragState.start,
                haversine(
                  dragState.start[0],
                  dragState.start[1],
                  dragState.end[0],
                  dragState.end[1],
                ),
              )}
              strokeColor="#a78bfa"
              strokeOpacity={0.65}
              strokeWeight={2}
            />
          )}

          {dragState && !templateConfirmed && templateMode === "grid" && (
            <PolygonOverlay
              path={rectanglePath(dragState.start, dragState.end)}
              strokeColor="#a78bfa"
              fillColor="#a78bfa"
              fillOpacity={0.08}
            />
          )}

          {dragState && !templateConfirmed && templateMode === "facade" && (
            <PolylineOverlay
              path={[
                { lat: dragState.start[0], lng: dragState.start[1] },
                { lat: dragState.end[0], lng: dragState.end[1] },
              ]}
              strokeColor="#a78bfa"
              strokeOpacity={0.8}
              strokeWeight={3}
            />
          )}

          {rawPath.length >= 2 && templateMode === "pencil" && (
            <PolylineOverlay
              path={rawPath.map(([lat, lng]) => ({ lat, lng }))}
              strokeColor="#a78bfa"
              strokeOpacity={0.8}
              strokeWeight={3}
            />
          )}

          {mapPreview?.waypoints.slice(0, -1).map((waypoint, index) => {
            const next = mapPreview.waypoints[index + 1];
            return (
              <PolylineOverlay
                key={`template-line-${index}`}
                path={[
                  toLatLng(waypoint.latitude, waypoint.longitude),
                  toLatLng(next.latitude, next.longitude),
                ]}
                strokeColor="#a78bfa"
                strokeOpacity={0.7}
                strokeWeight={2}
              />
            );
          })}

          {mapPreview?.waypoints.map((waypoint, index) => (
            <MarkerOverlay
              key={`template-waypoint-${index}`}
              position={toLatLng(waypoint.latitude, waypoint.longitude)}
              label={`${index + 1}`}
              fillColor="#7c3aed"
              strokeColor="#c4b5fd"
              scale={8}
            />
          ))}

          {mapPreview?.pois.map((poi, index) => (
            <MarkerOverlay
              key={`template-poi-${index}`}
              position={toLatLng(poi.latitude, poi.longitude)}
              fillColor="#ef4444"
              strokeColor="#fecaca"
              scale={7}
              iconPath="arrow"
            />
          ))}

          {showRnbLayer && selectedRnbCentroidPosition && (
            <MarkerOverlay
              position={selectedRnbCentroidPosition}
              label="C"
              title="Centroide batiment"
              fillColor="#111827"
              strokeColor="#ffffff"
              scale={7}
              zIndex={220}
            />
          )}
        </Map>

        <MapSearch value={searchValue} onValueChange={setSearchValue} />

        {showRnbLayer && selectedRnbBuilding && showSelectedRnbInfo && (
          <DraggablePanel
            className="left-4 top-4 z-10 w-[320px]"
            defaultPosition={{ x: 0, y: 0 }}
            title="Bâtiment RNB"
            onClose={handleClearSelectedBuilding}
          >
            <div className="p-3">
              {buildRnbInfoWindowContent({
                building: selectedRnbBuilding.building,
                bdTopoBuilding: selectedBdTopoBuilding,
                threeDMarkers: buildings3DMarkers,
                approximateBuildingShell: reconstructionShell,
                loading: selectedRnbBuildingLoading,
              })}
            </div>
          </DraggablePanel>
        )}

        {selectedRnbBuilding && showSelectedBuildingScanPanel && (
          <DraggablePanel
            className="left-4 top-4 z-10 w-[360px]"
            defaultPosition={{ x: 340, y: 0 }}
            title="Facade scan du bâtiment"
            onClose={clearTransientMapUi}
          >
            <div className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
                    Facade scan du bâtiment
                  </div>
                  <div className="mt-1 text-sm font-medium text-foreground">
                    {selectedRnbBuilding.building.rnbId}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {selectedBuildingFacadeSegments.length} façades détectées
                    {selectedBuildingHeightM != null
                      ? ` • hauteur ~ ${Math.round(selectedBuildingHeightM)} m`
                      : ""}
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`rounded-md border px-3 py-2 text-left text-xs ${selectedBuildingScanMode === "reconstruction-3d" ? "border-primary bg-primary/15 text-foreground" : "border-border bg-background/60 text-muted-foreground"}`}
                  onClick={() =>
                    setSelectedBuildingScanMode("reconstruction-3d")
                  }
                >
                  <div className="font-medium">3D reconstruction</div>
                  <div className="mt-1 text-[10px]">
                    Plan de vol photogrammétrique du bâtiment sélectionné
                  </div>
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-3 py-2 text-left text-xs ${selectedBuildingScanMode === "facade-scan" ? "border-primary bg-primary/15 text-foreground" : "border-border bg-background/60 text-muted-foreground"}`}
                  onClick={() => setSelectedBuildingScanMode("facade-scan")}
                >
                  <div className="font-medium">Scan des façades</div>
                  <div className="mt-1 text-[10px]">
                    Waypoints façade par façade pour le bâtiment sélectionné
                  </div>
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {buildingScanVariants.map((variant) => (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setSelectedBuildingScanVariantId(variant.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left ${selectedBuildingScanVariant?.id === variant.id ? "border-primary bg-primary/10" : "border-border bg-background/60"}`}
                  >
                    <div className="text-xs font-medium text-foreground">
                      {variant.label}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {variant.detail}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {variant.description}
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-3 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-[11px] text-muted-foreground">
                {selectedBuildingScanPreview
                  ? `${selectedBuildingScanPreview.label} affiché sur la carte • ${selectedBuildingScanPreview.mission.waypoints.length} waypoints`
                  : "Aucun aperçu exploitable pour cette configuration."}
              </div>

              {selectedBuildingScanMode === "facade-scan" &&
                selectedBuildingFacadeSegments.length > 0 && (
                  <div className="mt-3 rounded-md border border-border/70 bg-background/60 p-2">
                    <div className="text-[11px] font-medium text-foreground">
                      Façades prises en compte
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedBuildingFacadeSegments.map((segment) => (
                        <span
                          key={segment.id}
                          className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground"
                        >
                          {segment.label} • {segment.lengthM.toFixed(0)}m
                        </span>
                      ))}
                    </div>
                  </div>
                )}

              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-2 text-xs"
                  onClick={clearTransientMapUi}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                  onClick={handleSelectedBuildingScanApply}
                >
                  Apply
                </button>
              </div>
            </div>
          </DraggablePanel>
        )}

        {templateMode && !templateConfirmed && (
          <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-border bg-background/95 px-4 py-2 text-xs text-muted-foreground shadow-lg">
            {templateMode === "pencil"
              ? "Click to add path points, then double-click or use Finish."
              : "Click once to set the start point, then click again to define the template."}
          </div>
        )}

        {templateMode === "pencil" &&
          rawPath.length >= 2 &&
          !templateConfirmed && (
            <div className="absolute right-4 top-4 z-10 flex gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
              <button
                className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
                onClick={() => {
                  if (pathLength(rawPath) < MIN_PENCIL_PATH_LENGTH_M) return;
                  setPencilParams({ ...DEFAULT_PENCIL_PARAMS, path: rawPath });
                  setTemplateConfirmed(true);
                }}
              >
                Finish path
              </button>
              <button
                className="rounded-md border border-border px-3 py-2 text-xs"
                onClick={() => {
                  clearTransientMapUi();
                  setTemplateMode(null);
                }}
              >
                Cancel
              </button>
            </div>
          )}

        {drawingVertices.length >= 3 && (
          <div className="absolute right-4 top-4 z-10 flex gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
            <button
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
              onClick={() => addObstacle(drawingVertices)}
            >
              Finish obstacle
            </button>
            <button
              className="rounded-md border border-border px-3 py-2 text-xs"
              onClick={() => {
                setDrawingVertices([]);
                setIsDrawingObstacle(false);
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {activeTemplateType && templatePreview && (
          <TemplateConfigPanel
            type={activeTemplateType}
            orbitParams={orbitParams}
            gridParams={gridParams}
            facadeParams={facadeParams}
            pencilParams={pencilParams}
            onOrbitChange={setOrbitParams}
            onGridChange={setGridParams}
            onFacadeChange={setFacadeParams}
            onPencilChange={setPencilParams}
            onApply={() => {
              appendWaypoints(templatePreview.waypoints, templatePreview.pois);
              clearTransientMapUi();
              setTemplateMode(null);
            }}
            onCancel={() => {
              clearTransientMapUi();
              setTemplateMode(null);
            }}
            onFacadeAssist={
              activeTemplateType === "facade" ? handleFacadeAssist : undefined
            }
            onFacadeObjectiveChange={
              activeTemplateType === "facade"
                ? (objective) => {
                    setFacadeObjective(objective);
                    const seed = facadeAssistSeedParams ?? facadeParams;
                    if (!seed || !detectedBuilding) return;
                    const scenario = buildFacadeScenario(
                      seed,
                      detectedBuilding,
                      selectedFacadeSegmentId,
                      selectedFacadeVariantId,
                    );
                    if (!scenario) return;
                    void (async () => {
                      const recommendation = await refreshFacadeRecommendation(
                        detectedBuilding,
                        scenario,
                      );
                      setFacadeAssistMessage(
                        recommendation
                          ? `Goal switched to ${recommendation.objectiveLabel.toLowerCase()}. Copilot recommends ${recommendation.recommendedVariantLabel.toLowerCase()}.`
                          : "Mission goal updated.",
                      );
                    })();
                  }
                : undefined
            }
            onReconstructionPresetSelect={
              activeTemplateType === "facade" &&
              reconstructionPresets.length > 0
                ? handleReconstructionPresetSelect
                : undefined
            }
            onFacadeSegmentSelect={
              activeTemplateType === "facade"
                ? (segmentId) => {
                    const seed = facadeAssistSeedParams ?? facadeParams;
                    if (!seed || !detectedBuilding) return;
                    void (async () => {
                      const scenario = applyFacadeScenario(
                        detectedBuilding,
                        seed,
                        segmentId,
                        selectedFacadeVariantId,
                      );
                      if (!scenario) return;
                      const recommendation = await refreshFacadeRecommendation(
                        detectedBuilding,
                        scenario,
                      );
                      setFacadeAssistMessage(
                        recommendation
                          ? `${scenario.selectedSegment.label} selected. Copilot still prefers ${recommendation.recommendedVariantLabel.toLowerCase()}.`
                          : `${scenario.selectedSegment.label} selected, ${scenario.selectedVariant.label.toLowerCase()} variant at ${(scenario.selectedVariant.score * 100).toFixed(0)}%.`,
                      );
                    })();
                  }
                : undefined
            }
            onFacadeVariantSelect={
              activeTemplateType === "facade"
                ? (variantId) => {
                    const seed = facadeAssistSeedParams ?? facadeParams;
                    if (!seed || !detectedBuilding) return;
                    void (async () => {
                      const scenario = applyFacadeScenario(
                        detectedBuilding,
                        seed,
                        selectedFacadeSegmentId,
                        variantId,
                      );
                      if (!scenario) return;
                      const recommendation = await refreshFacadeRecommendation(
                        detectedBuilding,
                        scenario,
                      );
                      setFacadeAssistMessage(
                        recommendation
                          ? recommendation.currentVariantMatchesRecommendation
                            ? `${scenario.selectedVariant.label} matches the copilot recommendation.`
                            : `${scenario.selectedVariant.label} selected. Copilot recommends ${recommendation.recommendedVariantLabel.toLowerCase()} instead.`
                          : `${scenario.selectedVariant.label} variant selected with ${scenario.selectedVariant.detail}.`,
                      );
                    })();
                  }
                : undefined
            }
            facadeAssistBusy={facadeAssistBusy}
            facadeObjective={
              activeTemplateType === "facade" ? facadeObjective : undefined
            }
            facadeAssistMessage={
              activeTemplateType === "facade" ? facadeAssistMessage : null
            }
            facadeRecommendationBusy={
              activeTemplateType === "facade" ? facadeRecommendationBusy : false
            }
            facadeRecommendation={
              activeTemplateType === "facade" ? facadeRecommendation : null
            }
            reconstructionInfo={
              activeTemplateType === "facade" && reconstructionShell
                ? {
                    estimatedHeightLabel: `${Math.round(reconstructionShell.estimatedHeightM)}m`,
                    confidenceLabel: `${reconstructionShell.confidencePercent}%`,
                    roofLabel: reconstructionShell.roofStyleLabel,
                    sourceSummary: reconstructionShell.sourceSummary,
                    note: reconstructionShell.note,
                  }
                : null
            }
            reconstructionPresets={
              activeTemplateType === "facade"
                ? reconstructionPresets
                : undefined
            }
            facadeSegments={
              activeTemplateType === "facade"
                ? facadeSegmentOptions.map((segment) => ({
                    id: segment.id,
                    label: segment.label,
                    detail: `${segment.lengthM.toFixed(0)}m • ${segment.distanceToHintM.toFixed(0)}m off`,
                    selected: segment.id === selectedFacadeSegmentId,
                  }))
                : undefined
            }
            facadeVariants={
              activeTemplateType === "facade"
                ? facadeVariantOptions.map((variant) => ({
                    id: variant.id,
                    label: variant.label,
                    detail: variant.detail,
                    selected: variant.id === selectedFacadeVariantId,
                  }))
                : undefined
            }
            waypointCount={templatePreview.waypoints.length}
            pois={pois}
          />
        )}

        <Buildings3DPanel
          open={is3D}
          view={buildings3DView}
          markers={buildings3DMarkers}
          showRnbLayer={showRnbLayer}
          rnbBuildings={showRnbLayer ? rnbBuildings : []}
          selectedRnbBuildingId={selectedRnbBuilding?.building.rnbId ?? null}
          detectedBuilding={detectedBuilding}
          reconstructionShell={reconstructionShell}
          contextShells={contextShells}
          scanRoute={scanRoute3D}
          streetViewContext={streetViewContext}
          selectedSegment={selectedFacadeSegment}
          facadeRecommendation={facadeRecommendation}
          onClose={() => {
            setIs3D(false);
          }}
        />

        <div className="absolute bottom-4 left-4 z-10 flex gap-1">
          <button
            className={`px-2 py-1 text-xs rounded ${mapTypeId === ROADMAP_TYPE ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => setMapTypeId(ROADMAP_TYPE)}
          >
            Street
          </button>
          <button
            className={`px-2 py-1 text-xs rounded ${mapTypeId === HYBRID_TYPE ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => setMapTypeId(HYBRID_TYPE)}
          >
            Satellite
          </button>
          <div className="w-px bg-border mx-1" />
          <button
            className={`px-2 py-1 text-xs rounded ${!is3D ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => {
              setIs3D(false);
            }}
          >
            2D
          </button>
          <button
            className={`px-2 py-1 text-xs rounded ${is3D ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => setIs3D(true)}
          >
            3D
          </button>
          <div className="w-px bg-border mx-1" />
          <button
            className={`px-2 py-1 text-xs rounded ${showRnbLayer ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => setShowRnbLayer((value) => !value)}
          >
            Bâtiments 2D
          </button>
        </div>

        {showRnbLayer && rnbBuildings.length === 0 && (
          <div className="absolute bottom-16 left-4 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-lg">
            Aucune donnée RNB visible ici. Le référentiel couvre la France.
          </div>
        )}

        <MapToolbar
          selectedBuildingScanOption={{
            enabled: selectedRnbBuilding != null,
            description: selectedRnbBuilding
              ? "Ouvre le scan facade du bâtiment sélectionné"
              : "Sélectionnez un bâtiment sur la carte",
            onClick: openSelectedBuildingScanPanel,
          }}
          onClearAll={clearTransientMapUi}
        />
      </div>
    </APIProvider>
  );
}
