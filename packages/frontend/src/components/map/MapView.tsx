import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from "react";
import MapGL, {
  Source,
  Layer,
  Marker as GLMarker,
} from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import {
  RnbBuildingsLayer2D,
  MapInteraction2D,
  MapLibre3DController,
  WaypointBadgeAltitudeController,
  waypointAltitudeOffsetPx,
} from "./reactMapOverlays";
import { toast } from "sonner";
import { useMissionStore } from "@/store/missionStore";
import { useConfigStore } from "@/store/configStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { formatHeight } from "@/lib/units";
import {
  buildRnbExtrusionCollection,
  getObstacleWarnings,
  obstacleMaxHeightM,
  obstacleMinHeightM,
} from "@/lib/geo";
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
import { AirspaceOverlay } from "./AirspaceOverlay";
import type { PointOfInterest } from "@droneroute/shared";

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

type LatLng = { lat: number; lng: number };
type LatLngAltitude = { lat: number; lng: number; altitude: number };
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

type MainMapViewport = {
  center: LatLng;
  zoom: number;
  heading: number;
  tilt: number;
};

type Buildings3DMarker = {
  id: string;
  position: LatLng;
  glyph: string;
  label: string;
  background: string;
  borderColor: string;
  glyphColor: string;
  scale?: number;
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
  roofCoordinates: LatLngAltitude[];
  ridgeCoordinates: LatLngAltitude[] | null;
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
  position: LatLng;
};

type BuildingDetectionCacheEntry = {
  center: LatLng;
  radiusM: number;
  response: DetectBuildingResponse;
  cachedAt: number;
};

const MIN_PENCIL_PATH_LENGTH_M = 10;
const ROADMAP_TYPE = "roadmap";
const HYBRID_TYPE = "hybrid";
// Fonds 100% open-source (Licence Ouverte 2.0, sans clé) :
// - Plan IGN v2 (Géoplateforme WMTS) pour la vue "street"
// - BD ORTHO 20 cm (Géoplateforme WMTS) pour la vue "satellite"
// Docs : https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities
// Module-level pour garder une identité de style stable entre les renders
// (un objet inline forcerait react-map-gl à recharger tout le style à
// chaque render, avec un flash noir pendant le rechargement des tuiles).
const IGN_ATTRIBUTION =
  "© IGN – Géoplateforme | Licence Ouverte 2.0 | © OpenStreetMap contributors";
const IGN_PLAN_STYLE = {
  version: 8,
  sources: {
    "plan-ign": {
      type: "raster",
      tiles: [
        "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: IGN_ATTRIBUTION,
    },
  },
  layers: [{ id: "plan-ign-raster", type: "raster", source: "plan-ign" }],
} as any;
const IGN_ORTHO_STYLE = {
  version: 8,
  sources: {
    "bd-ortho": {
      type: "raster",
      tiles: [
        "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: IGN_ATTRIBUTION,
    },
  },
  layers: [{ id: "bd-ortho-raster", type: "raster", source: "bd-ortho" }],
} as any;
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
      clamp(heightM + (density === "dense" ? 12 : 8), 1, 100),
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

function RnbInfoSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function RnbInfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-px">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
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
  // Toutes les mesures sont conservées : hauteur, périmètre, longueur max,
  // largeur max, surface et longueurs de chaque segment de façade.
  const footprint = bdTopoBuilding?.footprint ?? building.footprint;
  const footprintSource = bdTopoBuilding ? "BD TOPO" : "RNB";
  const footprintMetrics = footprintMetricsSummary(footprint);
  const segments = footprintSegmentLengths(footprint);
  const vertexCount = normalizeFootprint(footprint).length;
  const centroid =
    bdTopoBuilding?.centroid ?? building.centroid ?? building.point;
  const usageLine = [bdTopoBuilding?.usage1, bdTopoBuilding?.usage2]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" / ");

  return (
    <div className="min-w-[220px] max-w-[300px] text-[12px] leading-[1.45] text-foreground">
      <div className="break-all font-mono text-[11px]">{building.rnbId}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span
          className={`rounded-full border px-2 py-px text-[10px] font-medium ${building.isActive ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border bg-muted text-muted-foreground"}`}
        >
          {building.isActive ? "Actif" : "Inactif"}
        </span>
        {building.status ? (
          <span className="rounded-full border border-border bg-muted px-2 py-px text-[10px] text-muted-foreground">
            {building.status}
          </span>
        ) : null}
        {loading ? (
          <span className="text-[10px] text-muted-foreground">
            Chargement BD TOPO…
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-2">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <span className="text-[11px] font-medium">
            Chargement des données BD TOPO…
          </span>
        </div>
      ) : null}

      <RnbInfoSection>Mesures</RnbInfoSection>
      <dl>
        <RnbInfoRow label="Hauteur">
          {bdTopoBuilding?.heightM != null
            ? `${Math.round(bdTopoBuilding.heightM)} m`
            : "—"}
        </RnbInfoRow>
        <RnbInfoRow label="Périmètre">
          {footprintMetrics.perimeterLabel}
        </RnbInfoRow>
        <RnbInfoRow label="Longueur max">
          {footprintMetrics.lengthLabel}
        </RnbInfoRow>
        <RnbInfoRow label="Largeur max">
          {footprintMetrics.widthLabel}
        </RnbInfoRow>
        <RnbInfoRow label="Surface">{footprintMetrics.areaLabel}</RnbInfoRow>
        <RnbInfoRow label="Sommets">
          {vertexCount > 0 ? vertexCount : "—"}
        </RnbInfoRow>
        <RnbInfoRow label="Emprise">{footprintSource}</RnbInfoRow>
      </dl>

      {segments.length > 0 ? (
        <>
          <RnbInfoSection>Façades · {segments.length} segments</RnbInfoSection>
          <div className="mt-1 grid max-h-28 grid-cols-2 gap-1 overflow-y-auto">
            {segments.map((segment) => (
              <div
                key={`segment-${segment.index}`}
                className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]"
              >
                S{segment.index} · {segment.lengthM.toFixed(1)} m
              </div>
            ))}
          </div>
        </>
      ) : null}

      <RnbInfoSection>Référentiels</RnbInfoSection>
      <dl>
        <RnbInfoRow label="Adresses liées">{building.addressCount}</RnbInfoRow>
        {building.extIds.length > 0 ? (
          <RnbInfoRow label="Id externes">{building.extIds.length}</RnbInfoRow>
        ) : null}
      </dl>
      {building.extIds.length > 0 ? (
        <div className="mt-1 space-y-px">
          {building.extIds.slice(0, 4).map((extId) => (
            <div
              key={`${extId.source}-${extId.id}`}
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={`${extId.source} : ${extId.id}`}
            >
              {extId.source} · {extId.id}
            </div>
          ))}
          {building.extIds.length > 4 ? (
            <div className="text-[11px] text-muted-foreground">
              +{building.extIds.length - 4} autres
            </div>
          ) : null}
        </div>
      ) : null}

      <RnbInfoSection>BD TOPO</RnbInfoSection>
      {bdTopoBuilding ? (
        <dl>
          <RnbInfoRow label="Cleabs">
            <span className="break-all font-mono text-[11px]">
              {bdTopoBuilding.cleabs}
            </span>
          </RnbInfoRow>
          <RnbInfoRow label="Nature">{bdTopoBuilding.nature ?? "—"}</RnbInfoRow>
          <RnbInfoRow label="Usage">{usageLine || "—"}</RnbInfoRow>
          <RnbInfoRow label="Étages">
            {bdTopoBuilding.floorCount != null
              ? Math.round(bdTopoBuilding.floorCount)
              : "—"}
          </RnbInfoRow>
          <RnbInfoRow label="Statut">{bdTopoBuilding.status ?? "—"}</RnbInfoRow>
          <RnbInfoRow label="Origine">
            {bdTopoBuilding.origin ?? "—"}
          </RnbInfoRow>
          {bdTopoBuilding.sourceMethodPlanimetric ? (
            <RnbInfoRow label="Précision plani">
              {bdTopoBuilding.sourceMethodPlanimetric}
            </RnbInfoRow>
          ) : null}
          {bdTopoBuilding.sourceMethodAltimetric ? (
            <RnbInfoRow label="Précision alti">
              {bdTopoBuilding.sourceMethodAltimetric}
            </RnbInfoRow>
          ) : null}
        </dl>
      ) : loading ? (
        <div className="animate-pulse space-y-1.5" aria-hidden="true">
          <div className="h-3 rounded bg-muted" />
          <div className="h-3 w-5/6 rounded bg-muted" />
          <div className="h-3 w-4/6 rounded bg-muted" />
          <div className="h-3 w-3/6 rounded bg-muted" />
        </div>
      ) : (
        <div className="text-muted-foreground">Aucun appariement BD TOPO</div>
      )}

      {centroid &&
      Number.isFinite(centroid.lat) &&
      Number.isFinite(centroid.lng) ? (
        <>
          <RnbInfoSection>Position</RnbInfoSection>
          <dl>
            <RnbInfoRow label="Centroïde">
              <span className="font-mono text-[11px]">
                {centroid.lat.toFixed(5)}, {centroid.lng.toFixed(5)}
              </span>
            </RnbInfoRow>
          </dl>
        </>
      ) : null}

      {approximateBuildingShell ? (
        <>
          <RnbInfoSection>Estimation 3D (heuristique)</RnbInfoSection>
          <div>{approximateBuildingShell.roofStyleLabel}</div>
          <dl>
            <RnbInfoRow label="Hauteur est.">
              {Math.round(approximateBuildingShell.estimatedHeightM)} m
            </RnbInfoRow>
            <RnbInfoRow label="Murs">
              {Math.round(approximateBuildingShell.wallHeightM)} m
            </RnbInfoRow>
            <RnbInfoRow label="Faîtage">
              {Math.round(approximateBuildingShell.roofPeakHeightM)} m
            </RnbInfoRow>
            <RnbInfoRow label="Fiabilité">
              {approximateBuildingShell.confidencePercent} %
            </RnbInfoRow>
          </dl>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Source : {approximateBuildingShell.heightSourceLabel}
          </div>
        </>
      ) : null}

      {threeDMarkers.length > 0 ? (
        <>
          <RnbInfoSection>Repères mission 3D</RnbInfoSection>
          {threeDMarkers.map((marker) => (
            <div key={marker.id}>
              <strong>{marker.glyph} :</strong> {marker.label}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function footprintSegmentLengths(
  footprint: LatLng[],
): { index: number; lengthM: number }[] {
  if (footprint.length < 2) {
    return [];
  }

  const hasClosingPoint =
    footprint.length >= 2 &&
    footprint[0].lat === footprint[footprint.length - 1].lat &&
    footprint[0].lng === footprint[footprint.length - 1].lng;
  const segmentCount = hasClosingPoint
    ? footprint.length - 1
    : footprint.length;

  if (segmentCount < 2) {
    return [];
  }

  const lengths: { index: number; lengthM: number }[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const start = footprint[index];
    const end = footprint[(index + 1) % segmentCount];
    lengths.push({
      index: index + 1,
      lengthM: haversine(start.lat, start.lng, end.lat, end.lng),
    });
  }

  return lengths;
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
  event: { domEvent?: unknown; originalEvent?: unknown } | undefined,
): "replace" | "toggle" | "range" {
  const domEvent =
    event?.domEvent ?? (event as { originalEvent?: unknown })?.originalEvent;
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
  // Hauteur réelle (plus de plancher à 12 m qui gonflait les petits
  // bâtiments : un bâtiment de 5 m donnait 34/40 m d'altitude).
  const estimatedHeightM = clamp(building.estimatedHeightM ?? 24, 3, 120);
  // Marges proportionnelles : identiques aux anciennes valeurs fixes pour
  // un bâtiment de ~24 m, réduites pour les petits bâtiments (avec des
  // planchers de sécurité : les alertes obstacles gardent le vol).
  const gridClearanceM = clamp(estimatedHeightM, 12, 22);
  const roofClearanceM = clamp(estimatedHeightM * 1.2, 15, 28);
  const orbitClearanceM = clamp(estimatedHeightM * 0.8, 10, 18);

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

  const buildingGridAltitude = Math.round(
    clamp(estimatedHeightM + gridClearanceM, 24, 90),
  );
  const roofGridAltitude = Math.round(
    clamp(estimatedHeightM + roofClearanceM, 30, 120),
  );
  const orbitAltitude = Math.round(
    clamp(estimatedHeightM + orbitClearanceM, 20, 120),
  );
  const orbitRadiusM = Math.round(clamp(footprintSizeM * 0.7, 18, 70));
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
      detail: `${roofGridAltitude}m • ${Math.round(clamp(footprintSizeM / 5, 8, 20))}m spacing`,
      description:
        "Classic nadir roof pass aligned to the footprint for top-down roof coverage.",
      templateType: "grid",
      gridParams: {
        ...DEFAULT_GRID_PARAMS,
        corner1: [minLat, minLng],
        corner2: [maxLat, maxLng],
        altitude: roofGridAltitude,
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
                1,
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
                1,
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
      detail: `${orbitRadiusM}m radius • ${orbitAltitude}m alt`,
      description:
        "Circular oblique ring around the footprint to capture facades and roof edges.",
      templateType: "orbit",
      orbitParams: {
        ...DEFAULT_ORBIT_PARAMS,
        center: [building.centroid.lat, building.centroid.lng],
        radiusM: orbitRadiusM,
        altitude: orbitAltitude,
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
  // Fiabilité : la hauteur mesurée (BD TOPO) prime toujours et n'est plus
  // écrasée par le plancher de 12 m (une maison de 7 m affichait 12 m).
  // Sans hauteur, les étages (× ~3 m) sont plus fiables que l'heuristique
  // de surface ; l'heuristique reste le dernier recours.
  const rawMeasuredHeightM = building.estimatedHeightM;
  const measuredHeightM =
    typeof rawMeasuredHeightM === "number" &&
    Number.isFinite(rawMeasuredHeightM) &&
    rawMeasuredHeightM > 0
      ? rawMeasuredHeightM
      : null;
  const rawLevels = building.levels;
  const levelsHeightM =
    measuredHeightM == null &&
    typeof rawLevels === "number" &&
    Number.isFinite(rawLevels) &&
    rawLevels > 0
      ? rawLevels * 3
      : null;
  const heightProvenance: "measured" | "levels" | "heuristic" =
    measuredHeightM != null
      ? "measured"
      : levelsHeightM != null
        ? "levels"
        : "heuristic";
  const estimatedHeightM =
    heightProvenance === "measured"
      ? clamp(measuredHeightM as number, 1, 120)
      : heightProvenance === "levels"
        ? clamp(levelsHeightM as number, 2, 120)
        : clamp(heuristicHeightM, 11, 48);
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
          // Plancher proportionnel (et non 1,8 m fixe) pour ne pas gonfler
          // la toiture des petits bâtiments.
          Math.min(1, estimatedHeightM * 0.14),
          Math.min(estimatedHeightM * 0.28, 12),
        );
  const wallHeightM = clamp(estimatedHeightM - roofRiseM, 1, estimatedHeightM);

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
  // Confiance calée sur la vraie provenance (mesurée > étages > heuristique)
  // plutôt que sur l'ancien libellé "osm-height" hérité.
  const heightConfidence =
    heightProvenance === "measured"
      ? 0.96
      : heightProvenance === "levels"
        ? 0.8
        : 0.6;
  const roofConfidence = building.roofShape ? 0.9 : 0.55;
  // Le contexte visuel n'est pas branché (null en dur à l'appel) : on
  // l'exclut du score au lieu de le pénaliser avec 0,25 fixe.
  const confidencePercent = streetViewContext
    ? Math.round(
        clamp(
          baseConfidence * 0.55 +
            heightConfidence * 0.25 +
            (streetViewContext.status === "available"
              ? clamp(1 - (streetViewContext.distanceM ?? 75) / 70, 0.35, 1)
              : streetViewContext.status === "unknown"
                ? 0.45
                : 0.25) *
              0.1 +
            roofConfidence * 0.1,
          0.42,
          0.97,
        ) * 100,
      )
    : Math.round(
        clamp(
          baseConfidence * 0.61 +
            heightConfidence * 0.28 +
            roofConfidence * 0.11,
          0.42,
          0.97,
        ) * 100,
      );
  const resolvedHeightSourceLabel =
    heightProvenance === "measured"
      ? "Hauteur BD TOPO"
      : heightProvenance === "levels"
        ? "Étages BD TOPO (× ~3 m)"
        : heightSourceLabel(building, heuristicHeightM);
  const roofStyleLabel = formatRoofStyleLabel(roofStyle);
  const streetViewLabel =
    streetViewContext?.label ?? "Visual context cue pending";

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
      "Open-source 3D context",
      streetViewLabel,
    ].join(" • "),
    note: `Hybrid estimate using OSM footprint, ${resolvedHeightSourceLabel.toLowerCase()}, open-source 3D context, and ${streetViewLabel.toLowerCase()}. The ${roofStyleLabel.toLowerCase()} is still heuristic, so the model remains approximate.`,
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

type BanSearchResult = { label: string; lat: number; lng: number };

function MapSearch({
  value,
  onValueChange,
  onPick,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onPick: (lat: number, lng: number) => void;
}) {
  const [error, setError] = useState("");
  const [results, setResults] = useState<BanSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const handleSearch = useCallback(async () => {
    const query = value.trim();
    if (!query) return;
    setSearching(true);
    setError("");
    try {
      // BAN (Base Adresse Nationale): free French address search, no key.
      const response = await fetch(
        `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=5`,
      );
      if (!response.ok) throw new Error(`search failed (${response.status})`);
      const payload = (await response.json()) as {
        features?: Array<{
          properties?: { label?: string };
          geometry?: { coordinates?: [number, number] };
        }>;
      };
      const parsed = (payload.features ?? [])
        .map((feature) => ({
          label: feature.properties?.label ?? "",
          lng: feature.geometry?.coordinates?.[0],
          lat: feature.geometry?.coordinates?.[1],
        }))
        .filter(
          (r): r is BanSearchResult =>
            r.label !== "" &&
            typeof r.lat === "number" &&
            typeof r.lng === "number",
        );
      if (parsed.length === 0) {
        setError("Location not found.");
        setResults([]);
        return;
      }
      setResults(parsed);
    } catch {
      setError("Search failed.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [value]);

  return (
    <>
      <div className="absolute left-4 top-4 z-10 flex w-[320px] gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
        <input
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSearch();
          }}
          placeholder="Search location..."
          className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
        />
        <button
          className="rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
          onClick={() => void handleSearch()}
          disabled={searching}
        >
          Search
        </button>
      </div>
      {results.length > 0 && (
        <div className="absolute left-4 top-16 z-10 w-[320px] overflow-hidden rounded-md border border-border bg-background/95 shadow-lg backdrop-blur-sm">
          {results.map((result) => (
            <button
              key={`${result.label}-${result.lat}-${result.lng}`}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-accent"
              onClick={() => {
                setResults([]);
                setError("");
                onPick(result.lat, result.lng);
              }}
            >
              {result.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="absolute left-4 top-16 z-10 rounded-md bg-destructive/90 px-3 py-2 text-xs text-destructive-foreground shadow">
          {error}
        </div>
      )}
    </>
  );
}

type MapViewChromeProps = {
  isSatellite: boolean;
  onSelectStreet: () => void;
  onSelectSatellite: () => void;
  is3D: boolean;
  onSelect2D: () => void;
  onSelect3D: () => void;
  showRnbLayer: boolean;
  onToggleRnbLayer: () => void;
  showRnbEmptyHint: boolean;
  scanOptionEnabled: boolean;
  scanOptionDescription: string;
  onScanOptionClick: () => void;
  onClearAll: () => void;
};

// Bottom-left view switcher, RNB hint and placement toolbar for the
// open-source map view.
function MapViewChrome({
  isSatellite,
  onSelectStreet,
  onSelectSatellite,
  is3D,
  onSelect2D,
  onSelect3D,
  showRnbLayer,
  onToggleRnbLayer,
  showRnbEmptyHint,
  scanOptionEnabled,
  scanOptionDescription,
  onScanOptionClick,
  onClearAll,
}: MapViewChromeProps) {
  return (
    <>
      <div className="absolute bottom-4 left-4 z-10 flex gap-1">
        <button
          className={`px-2 py-1 text-xs rounded ${!isSatellite ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
          onClick={onSelectStreet}
        >
          Street
        </button>
        <button
          className={`px-2 py-1 text-xs rounded ${isSatellite ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
          onClick={onSelectSatellite}
        >
          Satellite
        </button>
        <div className="w-px bg-border mx-1" />
        <button
          className={`px-2 py-1 text-xs rounded ${!is3D ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
          onClick={onSelect2D}
        >
          2D
        </button>
        <button
          className={`px-2 py-1 text-xs rounded ${is3D ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
          onClick={onSelect3D}
        >
          3D
        </button>
        <div className="w-px bg-border mx-1" />
        <button
          className={`px-2 py-1 text-xs rounded ${showRnbLayer ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
          onClick={onToggleRnbLayer}
        >
          Contour de bâtiment
        </button>
      </div>

      {showRnbEmptyHint && (
        <div className="absolute bottom-16 left-4 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-lg">
          Aucune donnée RNB visible ici. Le référentiel couvre la France.
        </div>
      )}

      <MapToolbar
        selectedBuildingScanOption={{
          enabled: scanOptionEnabled,
          description: scanOptionDescription,
          onClick: onScanOptionClick,
        }}
        onClearAll={onClearAll}
      />
    </>
  );
}

type MapTransientOverlaysProps = {
  templateMode: TemplateMode;
  rawPath: [number, number][];
  templateConfirmed: boolean;
  drawingVertices: [number, number][];
  onFinishPencil: () => void;
  onCancelPencil: () => void;
  onFinishObstacle: () => void;
  onCancelObstacle: () => void;
  activeTemplateType: TemplateMode;
  templatePreview: TemplateResult | null;
  orbitParams: OrbitParams | null;
  gridParams: GridParams | null;
  facadeParams: FacadeParams | null;
  pencilParams: PencilParams | null;
  onOrbitChange: (params: OrbitParams) => void;
  onGridChange: (params: GridParams) => void;
  onFacadeChange: (params: FacadeParams) => void;
  onPencilChange: (params: PencilParams) => void;
  onApply: () => void;
  onCancel: () => void;
  onFacadeAssist?: () => void;
  onFacadeObjectiveChange?: (objective: FacadeCopilotObjective) => void;
  onReconstructionPresetSelect?: (presetId: string) => void;
  onFacadeSegmentSelect?: (segmentId: string) => void;
  onFacadeVariantSelect?: (variantId: string) => void;
  facadeObjective?: FacadeCopilotObjective;
  facadeAssistBusy?: boolean;
  facadeAssistMessage?: string | null;
  facadeRecommendationBusy?: boolean;
  facadeRecommendation?: FacadeCopilotRecommendation | null;
  reconstructionShell: ReconstructedBuildingShell | null;
  reconstructionPresets: Array<{
    id: string;
    label: string;
    detail: string;
    description: string;
  }>;
  facadeSegmentOptions: FacadeSegmentOption[];
  selectedFacadeSegmentId: string | null;
  facadeVariantOptions: FacadeVariantOption[];
  selectedFacadeVariantId: string | null;
  pois: PointOfInterest[];
};

// Pencil/obstacle finish buttons and template configuration panel. Shared by
// the Google 3D view and the open-source 2D view.
function MapTransientOverlays({
  templateMode,
  rawPath,
  templateConfirmed,
  drawingVertices,
  onFinishPencil,
  onCancelPencil,
  onFinishObstacle,
  onCancelObstacle,
  activeTemplateType,
  templatePreview,
  orbitParams,
  gridParams,
  facadeParams,
  pencilParams,
  onOrbitChange,
  onGridChange,
  onFacadeChange,
  onPencilChange,
  onApply,
  onCancel,
  onFacadeAssist,
  onFacadeObjectiveChange,
  onReconstructionPresetSelect,
  onFacadeSegmentSelect,
  onFacadeVariantSelect,
  facadeObjective,
  facadeAssistBusy,
  facadeAssistMessage,
  facadeRecommendationBusy,
  facadeRecommendation,
  reconstructionShell,
  reconstructionPresets,
  facadeSegmentOptions,
  selectedFacadeSegmentId,
  facadeVariantOptions,
  selectedFacadeVariantId,
  pois,
}: MapTransientOverlaysProps) {
  return (
    <>
      {templateMode === "pencil" &&
        rawPath.length >= 2 &&
        !templateConfirmed && (
          <div className="absolute right-4 top-4 z-20 flex gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
            <button
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
              onClick={onFinishPencil}
            >
              Finish path
            </button>
            <button
              className="rounded-md border border-border px-3 py-2 text-xs"
              onClick={onCancelPencil}
            >
              Cancel
            </button>
          </div>
        )}

      {drawingVertices.length >= 3 && (
        <div className="absolute right-4 top-4 z-20 flex gap-2 rounded-lg border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
          <button
            className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
            onClick={onFinishObstacle}
          >
            Finish obstacle
          </button>
          <button
            className="rounded-md border border-border px-3 py-2 text-xs"
            onClick={onCancelObstacle}
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
          onOrbitChange={onOrbitChange}
          onGridChange={onGridChange}
          onFacadeChange={onFacadeChange}
          onPencilChange={onPencilChange}
          onApply={onApply}
          onCancel={onCancel}
          onFacadeAssist={
            activeTemplateType === "facade" ? onFacadeAssist : undefined
          }
          onFacadeObjectiveChange={
            activeTemplateType === "facade"
              ? onFacadeObjectiveChange
              : undefined
          }
          onReconstructionPresetSelect={
            activeTemplateType === "facade" && reconstructionPresets.length > 0
              ? onReconstructionPresetSelect
              : undefined
          }
          onFacadeSegmentSelect={
            activeTemplateType === "facade" ? onFacadeSegmentSelect : undefined
          }
          onFacadeVariantSelect={
            activeTemplateType === "facade" ? onFacadeVariantSelect : undefined
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
            activeTemplateType === "facade" ? reconstructionPresets : undefined
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
    </>
  );
}

export function MapView() {
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
  const isAddingWaypoint = useMissionStore((s) => s.isAddingWaypoint);
  const isAddingPoi = useMissionStore((s) => s.isAddingPoi);
  const isDrawingObstacle = useMissionStore((s) => s.isDrawingObstacle);
  const addWaypoint = useMissionStore((s) => s.addWaypoint);
  const addPoi = useMissionStore((s) => s.addPoi);
  const unitSystem = usePreferencesStore((s) => s.preferences.unitSystem);

  const [mapTypeId, setMapTypeId] = useState<string>(ROADMAP_TYPE);
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

  const reconstructionShell = useMemo(
    () =>
      buildApproximateBuildingShell(
        detectedBuilding,
        selectedFacadeSegment,
        null,
      ),
    [detectedBuilding, selectedFacadeSegment],
  );

  const buildings3DMarkers = useMemo(
    () =>
      buildBuildings3DMarkers({
        detectedBuilding,
        selectedSegment: selectedFacadeSegment,
        facadeRecommendation,
        streetViewContext: null,
      }),
    [detectedBuilding, facadeRecommendation, selectedFacadeSegment],
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
          // Keep the cache warm for later assists, even though the editor no
          // longer renders the full candidate cloud explicitly.
        }
      } catch {
        findCachedBuildingDetection(
          buildingDetectionCacheRef,
          queryCenter,
          radiusM,
        );

        if (!cancelled) {
          // No explicit candidate rendering in the open-source map view.
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

  // État dérivé du bâtiment détecté (empreinte teal + segments de façade).
  // Factorisé car trois chemins l'effacent : reset template, "Fermer"/clic
  // dans le vide, et Escape.
  const clearDetectedBuildingState = useCallback(() => {
    setDetectedBuilding(null);
    setFacadeAssistSeedParams(null);
    setFacadeSegmentOptions([]);
    setSelectedFacadeSegmentId(null);
  }, []);

  const resetTemplateState = useCallback(() => {
    setDragState(null);
    setRawPath([]);
    setTemplateConfirmed(false);
    setOrbitParams(null);
    setGridParams(null);
    setFacadeParams(null);
    setPencilParams(null);
    clearDetectedBuildingState();
    setFacadeVariantOptions([]);
    setSelectedFacadeVariantId(null);
    setFacadeAssistBusy(false);
    setFacadeAssistMessage(null);
    setFacadeRecommendation(null);
    setFacadeRecommendationBusy(false);
  }, [clearDetectedBuildingState]);

  const clearTransientMapUi = useCallback(() => {
    resetTemplateState();
    clearSelectedBuildingUi();
  }, [clearSelectedBuildingUi, resetTemplateState]);

  // Escape revient à l'état nominal : annule les brouillons en cours
  // (templates, pencil, dessin d'obstacle), ferme les panneaux bâtiment et
  // efface la sélection (y compris l'empreinte teal via resetTemplateState).
  // Comme le handler App, Escape fonctionne même depuis un champ de saisie.
  // (Le handler App efface en plus les modes de placement et la sélection
  // de waypoints.)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        templateMode ||
        rawPath.length > 0 ||
        dragState ||
        drawingVertices.length > 0 ||
        selectedRnbBuilding ||
        showSelectedRnbInfo ||
        showSelectedBuildingScanPanel
      ) {
        clearTransientMapUi();
        setDrawingVertices([]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    templateMode,
    rawPath,
    dragState,
    drawingVertices,
    selectedRnbBuilding,
    showSelectedRnbInfo,
    showSelectedBuildingScanPanel,
    clearTransientMapUi,
    setDrawingVertices,
  ]);

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
      setFacadeSegmentOptions([]);
      setSelectedFacadeSegmentId(null);
      setFacadeVariantOptions([]);
      setSelectedFacadeVariantId(null);
      setFacadeRecommendation(null);
      setFacadeRecommendationBusy(false);
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
      setFacadeAssistSeedParams(null);
      setFacadeSegmentOptions([]);
      setSelectedFacadeSegmentId(null);
      setFacadeVariantOptions([]);
      setSelectedFacadeVariantId(null);
      setFacadeAssistBusy(false);
      setFacadeRecommendation(null);
      setFacadeRecommendationBusy(false);

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
    (building: RnbBuilding, position: LatLng) => {
      setSelectedRnbBuilding({ building, position });
      setShowSelectedRnbInfo(true);
    },
    [],
  );

  const handleClearSelectedBuilding = useCallback(() => {
    // Sans ça, l'empreinte teal + les segments de façade (dérivés de
    // detectedBuilding) restaient affichés après "Fermer" ou un clic dans
    // le vide : le dernier bâtiment semblait rester sélectionné.
    // Gardé sous condition pour ne pas effacer l'aperçu d'un scan de
    // façade générique (sans bâtiment RNB) lors d'un clic dans le vide.
    if (selectedRnbBuilding) {
      clearDetectedBuildingState();
    }
    clearSelectedBuildingUi();
  }, [
    clearSelectedBuildingUi,
    clearDetectedBuildingState,
    selectedRnbBuilding,
  ]);

  const openSelectedBuildingScanPanel = useCallback(() => {
    if (!selectedRnbBuilding) {
      toast.error("Sélectionnez d’abord un bâtiment.");
      return;
    }

    setShowSelectedBuildingScanPanel(true);
  }, [selectedRnbBuilding]);

  // Single open-source map engine (MapLibre): 2D street map with buildings,
  // or 3D with terrain relief + extruded buildings when is3D is set.

  // These hooks must run unconditionally on every render (never after an
  // early return): switching between the 2D and 3D views would otherwise
  // change the hook order and crash React.
  const mapRef = useRef<any>(null);

  // GeoJSON for route and points (used in the 2D open-source view)
  const routeGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: waypoints.map((w) => [w.longitude, w.latitude]),
          },
        },
      ],
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [waypoints]);

  const pointsGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: waypoints.map((w) => ({
        type: "Feature",
        properties: { index: w.index },
        geometry: { type: "Point", coordinates: [w.longitude, w.latitude] },
      })),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [waypoints]);

  // GeoJSON for POIs, obstacles and the obstacle-drawing preview (2D view)
  const poisGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: pois.map((p) => ({
        type: "Feature",
        properties: { id: p.id, name: p.name },
        geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      })),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [pois]);

  const obstaclesGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: obstacles
        .filter((o) => o.vertices.length >= 3)
        .map((o) => {
          const ring = o.vertices.map(
            ([lat, lng]) => [lng, lat] as [number, number],
          );
          ring.push(ring[0]);
          return {
            type: "Feature",
            properties: {
              id: o.id,
              name: o.name,
              minH: obstacleMinHeightM(o),
              maxH: obstacleMaxHeightM(o),
            },
            geometry: { type: "Polygon", coordinates: [ring] },
          };
        }),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [obstacles]);

  // RNB footprints with app-estimated heights for the 3D extrusion layer.
  // Uses the exact BD TOPO height for the selected building when matched,
  // otherwise the footprint-area heuristic (OSM height tags are sparse).
  const rnbExtrusionGeo = useMemo(() => {
    return buildRnbExtrusionCollection(
      rnbBuildings.map((b) => ({
        rnbId: b.rnbId,
        footprint: b.footprint,
        heightM:
          b.rnbId === selectedRnbBuilding?.building.rnbId &&
          selectedBdTopoBuilding?.heightM != null
            ? estimatedBuildingHeightM(b, selectedBdTopoBuilding)
            : estimatedBuildingHeightM(b, null),
      })),
    );
  }, [rnbBuildings, selectedRnbBuilding, selectedBdTopoBuilding]);

  const drawingPreviewGeo = useMemo(() => {
    if (drawingVertices.length === 0) return null;
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: drawingVertices.map(([lat, lng]) => [lng, lat]),
          },
        },
      ],
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [drawingVertices]);

  // Dashed flight segments (blue, red where the path conflicts with an
  // obstacle) for the open-source view.
  const flightSegmentsGeo = useMemo(() => {
    const normal: [number, number][][] = [];
    const warned: [number, number][][] = [];
    waypoints.slice(0, -1).forEach((waypoint, index) => {
      const next = waypoints[index + 1];
      const segment: [number, number][] = [
        [waypoint.longitude, waypoint.latitude],
        [next.longitude, next.latitude],
      ];
      if (warningSegments.has(waypoint.index)) warned.push(segment);
      else normal.push(segment);
    });
    const toCollection = (segments: [number, number][][]) =>
      ({
        type: "FeatureCollection",
        features: segments.map((coordinates) => ({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates },
        })),
      }) as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
    return { normal: toCollection(normal), warned: toCollection(warned) };
  }, [waypoints, warningSegments]);

  // Rideau vertical sous le tracé (visible en 3D uniquement) : chaque
  // segment devient un mur fin montant du sol à l'altitude du segment.
  // La ligne plate ne peut pas montrer les hauteurs (drapée au terrain),
  // le rideau si.
  const routeCurtainGeo = useMemo(() => {
    const toWalls = (segments: [number, number][][], heights: number[]) =>
      ({
        type: "FeatureCollection",
        features: segments.map((coordinates, index) => {
          const [lng1, lat1] = coordinates[0];
          const [lng2, lat2] = coordinates[1];
          const perpRad =
            ((bearingTo(lat1, lng1, lat2, lng2) + 90) * Math.PI) / 180;
          // Demi-largeur 1,5 m : lisible en zoom bâtiment sans épaissir
          // le tracé à l'échelle quartier.
          const northM = Math.cos(perpRad) * 1.5;
          const eastM = Math.sin(perpRad) * 1.5;
          const [plus1Lat, plus1Lng] = offsetMeters(lat1, lng1, northM, eastM);
          const [plus2Lat, plus2Lng] = offsetMeters(lat2, lng2, northM, eastM);
          const [minus1Lat, minus1Lng] = offsetMeters(
            lat1,
            lng1,
            -northM,
            -eastM,
          );
          const [minus2Lat, minus2Lng] = offsetMeters(
            lat2,
            lng2,
            -northM,
            -eastM,
          );
          return {
            type: "Feature",
            properties: { h: heights[index] ?? 0 },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [plus1Lng, plus1Lat],
                  [plus2Lng, plus2Lat],
                  [minus2Lng, minus2Lat],
                  [minus1Lng, minus1Lat],
                  [plus1Lng, plus1Lat],
                ],
              ],
            },
          };
        }),
      }) as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
    const normalSegs: [number, number][][] = [];
    const normalHeights: number[] = [];
    const warnedSegs: [number, number][][] = [];
    const warnedHeights: number[] = [];
    waypoints.slice(0, -1).forEach((waypoint, index) => {
      const next = waypoints[index + 1];
      const segment: [number, number][] = [
        [waypoint.longitude, waypoint.latitude],
        [next.longitude, next.latitude],
      ];
      const height = Math.max(waypoint.height, next.height);
      if (warningSegments.has(waypoint.index)) {
        warnedSegs.push(segment);
        warnedHeights.push(height);
      } else {
        normalSegs.push(segment);
        normalHeights.push(height);
      }
    });
    return {
      normal: toWalls(normalSegs, normalHeights),
      warned: toWalls(warnedSegs, warnedHeights),
    };
  }, [waypoints, warningSegments]);

  // Colonnes 3D par waypoint (visibles en 3D uniquement) : chaque point
  // monte du sol à sa hauteur exacte — le sommet de la colonne EST le
  // waypoint à son altitude (les marqueurs DOM restent au sol pour le
  // drag & clic).
  const waypointPillarsGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: waypoints.map((waypoint) => {
        const [n1Lat, n1Lng] = offsetMeters(
          waypoint.latitude,
          waypoint.longitude,
          1,
          1,
        );
        const [n2Lat, n2Lng] = offsetMeters(
          waypoint.latitude,
          waypoint.longitude,
          1,
          -1,
        );
        const [n3Lat, n3Lng] = offsetMeters(
          waypoint.latitude,
          waypoint.longitude,
          -1,
          -1,
        );
        const [n4Lat, n4Lng] = offsetMeters(
          waypoint.latitude,
          waypoint.longitude,
          -1,
          1,
        );
        return {
          type: "Feature",
          properties: {
            h: waypoint.height,
            selected: selectedWaypointIndices.has(waypoint.index),
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [n1Lng, n1Lat],
                [n2Lng, n2Lat],
                [n3Lng, n3Lat],
                [n4Lng, n4Lat],
                [n1Lng, n1Lat],
              ],
            ],
          },
        };
      }),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [waypoints, selectedWaypointIndices]);

  // Green dashed lines from "toward POI" waypoints to their POI.
  const poiLinesGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: waypoints.flatMap((waypoint) => {
        const targetPoi =
          waypoint.headingMode === "towardPOI" && waypoint.poiId
            ? pois.find((poi) => poi.id === waypoint.poiId)
            : null;
        if (!targetPoi) return [];
        return [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [waypoint.longitude, waypoint.latitude],
                [targetPoi.longitude, targetPoi.latitude],
              ],
            },
          },
        ];
      }),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [waypoints, pois]);

  // Red heading indicators for waypoints with an explicit heading.
  const headingLinesGeo = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: waypointHeadings
        .filter(({ waypoint }) => hasExplicitHeading(waypoint))
        .map(({ waypoint, heading }) => ({
          type: "Feature",
          properties: {
            selected: selectedWaypointIndices.has(waypoint.index),
          },
          geometry: {
            type: "LineString",
            coordinates: headingPath(waypoint, heading).map(
              (p): [number, number] => [p.lng, p.lat],
            ),
          },
        })),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [waypointHeadings, selectedWaypointIndices]);

  // Camera frustum footprint for the single selected waypoint.
  const frustumGeo = useMemo(() => {
    if (!singleSelectedWaypoint || !frustumCorners) return null;
    const ring = frustumCorners.map(([lat, lng]): [number, number] => [
      lng,
      lat,
    ]);
    ring.push(ring[0]);
    const edges = frustumCorners.map(([lat, lng]) => ({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [singleSelectedWaypoint.longitude, singleSelectedWaypoint.latitude],
          [lng, lat],
        ],
      },
    }));
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [ring] },
        },
        ...edges,
      ],
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [singleSelectedWaypoint, frustumCorners]);

  // Detected building footprint + clickable facade segments.
  const detectedBuildingGeo = useMemo(() => {
    if (!detectedBuilding) return null;
    const footprint = detectedBuilding.footprint.map(
      (point): [number, number] => [point.lng, point.lat],
    );
    if (footprint.length >= 3) footprint.push(footprint[0]);
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "footprint" },
          geometry: { type: "Polygon", coordinates: [footprint] },
        },
        ...facadeSegmentOptions.map((segment) => ({
          type: "Feature",
          properties: {
            kind: "segment",
            id: segment.id,
            selected: segment.id === selectedFacadeSegmentId,
          },
          geometry: {
            type: "LineString",
            coordinates: [
              [segment.start.lng, segment.start.lat],
              [segment.end.lng, segment.end.lat],
            ],
          },
        })),
      ],
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [detectedBuilding, facadeSegmentOptions, selectedFacadeSegmentId]);

  // Template drag previews + pencil path + generated preview (purple).
  const templateSketchGeo = useMemo(() => {
    const lines: [number, number][][] = [];
    if (dragState && !templateConfirmed) {
      if (templateMode === "orbit") {
        lines.push(
          circlePath(
            dragState.start,
            haversine(
              dragState.start[0],
              dragState.start[1],
              dragState.end[0],
              dragState.end[1],
            ),
          ).map((p): [number, number] => [p.lng, p.lat]),
        );
      } else if (templateMode === "grid") {
        const rect = rectanglePath(dragState.start, dragState.end).map(
          (p): [number, number] => [p.lng, p.lat],
        );
        rect.push(rect[0]);
        lines.push(rect);
      } else if (templateMode === "facade") {
        lines.push([
          [dragState.start[1], dragState.start[0]],
          [dragState.end[1], dragState.end[0]],
        ]);
      }
    }
    if (templateMode === "pencil" && rawPath.length >= 2) {
      lines.push(rawPath.map(([lat, lng]): [number, number] => [lng, lat]));
    }
    if (mapPreview) {
      mapPreview.waypoints.slice(0, -1).forEach((waypoint, index) => {
        const next = mapPreview.waypoints[index + 1];
        lines.push([
          [waypoint.longitude, waypoint.latitude],
          [next.longitude, next.latitude],
        ]);
      });
    }
    return {
      type: "FeatureCollection",
      features: lines.map((coordinates) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates },
      })),
    } as GeoJSON.FeatureCollection<GeoJSON.Geometry>;
  }, [dragState, templateConfirmed, templateMode, rawPath, mapPreview]);

  // Transient UI callbacks shared by the map views (used by
  // MapTransientOverlays).
  const handleTemplateApply = () => {
    if (!templatePreview) return;
    appendWaypoints(templatePreview.waypoints, templatePreview.pois);
    clearTransientMapUi();
    setTemplateMode(null);
  };

  const handleTemplateCancel = () => {
    clearTransientMapUi();
    setTemplateMode(null);
  };

  const handleFinishPencil = () => {
    if (pathLength(rawPath) < MIN_PENCIL_PATH_LENGTH_M) return;
    setPencilParams({ ...DEFAULT_PENCIL_PARAMS, path: rawPath });
    setTemplateConfirmed(true);
  };

  const handleCancelPencil = () => {
    clearTransientMapUi();
    setTemplateMode(null);
  };

  const handleFinishObstacle = () => {
    addObstacle(drawingVertices);
  };

  const handleCancelObstacle = () => {
    setDrawingVertices([]);
    setIsDrawingObstacle(false);
  };

  const handleSelect3D = () => {
    // 3D always works: Google 3D with a valid key, otherwise open-source
    // MapLibre 3D (terrain relief + extruded buildings, no key required).
    setIs3D(true);
  };

  const handleFacadeSegmentClick = (segmentId: string) => {
    const seed = facadeAssistSeedParams ?? facadeParams;
    if (!seed || !detectedBuilding) return;
    const scenario = applyFacadeScenario(
      detectedBuilding,
      seed,
      segmentId,
      selectedFacadeVariantId,
    );
    if (!scenario) return;
    setFacadeAssistMessage(
      `${scenario.selectedSegment.label} selected, ${scenario.selectedVariant.label.toLowerCase()} variant at ${(scenario.selectedVariant.score * 100).toFixed(0)}%.`,
    );
  };

  const handleSearchPick = useCallback((lat: number, lng: number) => {
    mapRef.current?.getMap?.()?.flyTo({ center: [lng, lat], zoom: 15 });
  }, []);

  // Fit the map to the mission when waypoints first appear.
  const prevWaypointCountRef = useRef(0);
  useEffect(() => {
    const wasEmpty = prevWaypointCountRef.current === 0;
    prevWaypointCountRef.current = waypoints.length;
    if (!wasEmpty || waypoints.length < 2) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const lngs = [
      ...waypoints.map((w) => w.longitude),
      ...pois.map((p) => p.longitude),
      ...obstacles.flatMap((o) => o.vertices.map(([, lng]) => lng)),
    ];
    const lats = [
      ...waypoints.map((w) => w.latitude),
      ...pois.map((p) => p.latitude),
      ...obstacles.flatMap((o) => o.vertices.map(([lat]) => lat)),
    ];
    if (lngs.length === 0) return;
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 48 },
    );
  }, [waypoints, pois, obstacles]);

  // Publish the viewport for flows that depend on it (RNB auto-detect,
  // facade assist seeding).
  useEffect(() => {
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const publish = () => {
      const center = map.getCenter();
      if (!center) return;
      setMainMapViewport({
        center: { lat: center.lat, lng: center.lng },
        zoom: map.getZoom() ?? 15,
        heading: map.getBearing?.() ?? 0,
        tilt: map.getPitch?.() ?? 0,
      });
    };
    publish();
    map.on("moveend", publish);
    return () => {
      map.off("moveend", publish);
    };
  }, []);

  const handleFacadeObjectiveChange = (objective: FacadeCopilotObjective) => {
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
  };

  const handleFacadeSegmentSelect = (segmentId: string) => {
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
  };

  const handleFacadeVariantSelect = (variantId: string) => {
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
  };

  // Fonds 100% Licence Ouverte (sans clé) :
  // - Street : Plan IGN v2 WMTS (précis France, MAJ continue BD TOPO)
  // - Satellite/Hybrid : BD ORTHO WMTS 20 cm (France vue du ciel)
  // Les styles IGN_*_STYLE (module-level) gardent une identité stable entre
  // les renders (voir ci-dessus).

  // Open-source 3D mode: same map, pitched camera + terrain relief (see
  // MapLibre3DController) + extruded buildings below.
  const mapLibre3D = is3D;
  return (
    <div className="relative h-full w-full">
      <MapGL
        ref={mapRef}
        initialViewState={{
          longitude: defaultMapView.longitude,
          latitude: defaultMapView.latitude,
          zoom: defaultMapView.zoom,
          pitch: mapLibre3D ? 60 : 0,
        }}
        // maplibre-gl v4 lacks GlobeControl required by react-map-gl v8
        // types (v5-only API); the runtime APIs we use are identical.
        mapLib={maplibregl as any}
        mapStyle={mapTypeId === HYBRID_TYPE ? IGN_ORTHO_STYLE : IGN_PLAN_STYLE}
        // Fonds IGN plafonnés au zoom 19 : au-delà, les tuiles n'existent
        // pas et la carte affiche du vide (zones noires en zoom bâtiment).
        maxZoom={19}
        style={{ width: "100%", height: "100%" }}
      >
        <Source id="route" type="geojson" data={routeGeo}>
          <Layer
            id="route-line"
            type="line"
            paint={{
              "line-color": "#f59e0b",
              "line-width": 4,
            }}
          />
        </Source>
        <Source id="points" type="geojson" data={pointsGeo}>
          <Layer
            id="points-circle"
            type="circle"
            // Masqués en 3D : les marqueurs flottants prennent le relais
            // (sinon deux ronds par waypoint, au sol et en l'air).
            layout={{
              visibility: mapLibre3D ? "none" : "visible",
            }}
            paint={{
              "circle-radius": 6,
              "circle-color": "#2563eb",
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 1,
            }}
          />
        </Source>
        <Source id="pois" type="geojson" data={poisGeo}>
          <Layer
            id="pois-circle"
            type="circle"
            paint={{
              "circle-radius": 7,
              "circle-color": "#0d9488",
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 2,
            }}
          />
        </Source>
        <Source id="obstacles" type="geojson" data={obstaclesGeo}>
          <Layer
            id="obstacles-fill"
            type="fill"
            paint={{
              "fill-color": "#ef4444",
              "fill-opacity": 0.15,
            }}
          />
          <Layer
            id="obstacles-outline"
            type="line"
            paint={{
              "line-color": "#ef4444",
              "line-width": 2,
              "line-dasharray": [2, 2],
            }}
          />
          {/* Volume min→max en 3D pour visualiser la hauteur paramétrée. */}
          <Layer
            id="obstacles-3d"
            type="fill-extrusion"
            layout={{
              visibility: mapLibre3D ? "visible" : "none",
            }}
            paint={{
              "fill-extrusion-color": "#ef4444",
              "fill-extrusion-height": ["coalesce", ["get", "maxH"], 30],
              "fill-extrusion-base": ["coalesce", ["get", "minH"], 0],
              "fill-extrusion-opacity": 0.35,
            }}
          />
        </Source>
        {drawingPreviewGeo && (
          <Source id="drawing-preview" type="geojson" data={drawingPreviewGeo}>
            <Layer
              id="drawing-preview-line"
              type="line"
              paint={{
                "line-color": "#ef4444",
                "line-width": 2,
                "line-dasharray": [2, 2],
              }}
            />
          </Source>
        )}
        {/* Dashed flight segments (red on obstacle conflicts) */}
        <Source
          id="flight-normal"
          type="geojson"
          data={flightSegmentsGeo.normal}
        >
          <Layer
            id="flight-normal-line"
            type="line"
            paint={{
              "line-color": "#3b82f6",
              "line-width": 3,
              "line-dasharray": [2, 2],
            }}
          />
        </Source>
        <Source
          id="flight-warned"
          type="geojson"
          data={flightSegmentsGeo.warned}
        >
          <Layer
            id="flight-warned-line"
            type="line"
            paint={{
              "line-color": "#ef4444",
              "line-width": 3,
              "line-dasharray": [2, 2],
            }}
          />
        </Source>
        {/* Colonnes 3D des waypoints : montent à la hauteur exacte
            de chaque point (visibles en 3D uniquement). */}
        <Source id="waypoint-pillars" type="geojson" data={waypointPillarsGeo}>
          <Layer
            id="waypoint-pillars-extrusion"
            type="fill-extrusion"
            layout={{
              visibility: mapLibre3D ? "visible" : "none",
            }}
            paint={{
              "fill-extrusion-color": [
                "case",
                ["get", "selected"],
                "#93c5fd",
                "#3b82f6",
              ],
              "fill-extrusion-height": ["coalesce", ["get", "h"], 0],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.55,
              "fill-extrusion-vertical-gradient": false,
            }}
          />
        </Source>
        {/* Rideau 3D du tracé : murs montant à l'altitude de vol
            (visibles en 3D uniquement). */}
        <Source
          id="route-curtain-normal"
          type="geojson"
          data={routeCurtainGeo.normal}
        >
          <Layer
            id="route-curtain-normal-extrusion"
            type="fill-extrusion"
            layout={{
              visibility: mapLibre3D ? "visible" : "none",
            }}
            paint={{
              "fill-extrusion-color": "#3b82f6",
              "fill-extrusion-height": ["coalesce", ["get", "h"], 0],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.35,
              "fill-extrusion-vertical-gradient": false,
            }}
          />
        </Source>
        <Source
          id="route-curtain-warned"
          type="geojson"
          data={routeCurtainGeo.warned}
        >
          <Layer
            id="route-curtain-warned-extrusion"
            type="fill-extrusion"
            layout={{
              visibility: mapLibre3D ? "visible" : "none",
            }}
            paint={{
              "fill-extrusion-color": "#ef4444",
              "fill-extrusion-height": ["coalesce", ["get", "h"], 0],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.4,
              "fill-extrusion-vertical-gradient": false,
            }}
          />
        </Source>
        {/* Green dashed lines toward POIs */}
        <Source id="poi-lines" type="geojson" data={poiLinesGeo}>
          <Layer
            id="poi-lines-line"
            type="line"
            paint={{
              "line-color": "#4ade80",
              "line-width": 2,
              "line-dasharray": [2, 2],
            }}
          />
        </Source>
        {/* Red heading indicators */}
        <Source id="heading-lines" type="geojson" data={headingLinesGeo}>
          <Layer
            id="heading-lines-line"
            type="line"
            paint={{
              "line-color": "#ef4444",
              "line-width": ["case", ["get", "selected"], 3, 2],
              "line-opacity": ["case", ["get", "selected"], 0.85, 0.45],
            }}
          />
        </Source>
        {/* Camera frustum footprint for the selected waypoint */}
        {frustumGeo && (
          <Source id="frustum" type="geojson" data={frustumGeo}>
            <Layer
              id="frustum-fill"
              type="fill"
              paint={{
                "fill-color": "#94a3b8",
                "fill-opacity": 0.12,
              }}
            />
            <Layer
              id="frustum-outline"
              type="line"
              paint={{
                "line-color": "#94a3b8",
                "line-width": 2,
                "line-opacity": 0.6,
              }}
            />
          </Source>
        )}
        {/* Detected building footprint + clickable facade segments */}
        {detectedBuildingGeo && (
          <Source
            id="detected-building"
            type="geojson"
            data={detectedBuildingGeo}
          >
            <Layer
              id="detected-building-fill"
              type="fill"
              filter={["==", ["get", "kind"], "footprint"]}
              paint={{
                "fill-color": "#14b8a6",
                "fill-opacity": 0.08,
              }}
            />
            <Layer
              id="detected-building-outline"
              type="line"
              filter={["==", ["get", "kind"], "footprint"]}
              paint={{
                "line-color": "#14b8a6",
                "line-width": 2,
                "line-opacity": 0.8,
              }}
            />
            <Layer
              id="facade-segments-line"
              type="line"
              filter={["==", ["get", "kind"], "segment"]}
              paint={{
                "line-color": [
                  "case",
                  ["get", "selected"],
                  "#14b8a6",
                  "#f59e0b",
                ],
                "line-width": ["case", ["get", "selected"], 5, 3],
                "line-opacity": ["case", ["get", "selected"], 0.95, 0.7],
              }}
            />
          </Source>
        )}
        {/* Template drag previews + pencil path (purple) */}
        <Source id="template-sketch" type="geojson" data={templateSketchGeo}>
          <Layer
            id="template-sketch-line"
            type="line"
            paint={{
              "line-color": "#a78bfa",
              "line-width": 2,
              "line-opacity": 0.8,
            }}
          />
        </Source>
        {/* Extruded 3D buildings (OpenFreeMap vector tiles, visible in 3D).
            Hidden while the contour layer is on: mode contour = relief +
            tracés uniquement, sans bâtiments agrandis. */}
        <Source
          id="ofm-buildings"
          type="vector"
          url="https://tiles.openfreemap.org/planet"
          maxzoom={14}
        >
          <Layer
            id="buildings-3d"
            type="fill-extrusion"
            source-layer="building"
            minzoom={13}
            layout={{
              visibility: mapLibre3D && !showRnbLayer ? "visible" : "none",
            }}
            paint={{
              "fill-extrusion-color": "#c8ccd2",
              "fill-extrusion-height": [
                "coalesce",
                ["get", "render_height"],
                12,
              ],
              "fill-extrusion-base": [
                "coalesce",
                ["get", "render_min_height"],
                0,
              ],
              "fill-extrusion-opacity": 0.85,
            }}
          />
        </Source>
        {/* Mode "Contour de bâtiment" : pas d'extrusion des bâtiments RNB
            en 3D, uniquement le contour bleu épaissi (voir
            RnbBuildingsLayer2D lineWidth ci-dessous). */}
        <Source id="rnb-buildings-3d" type="geojson" data={rnbExtrusionGeo}>
          <Layer
            id="rnb-buildings-3d-extrusion"
            type="fill-extrusion"
            minzoom={13}
            layout={{
              visibility: "none",
            }}
            paint={{
              "fill-extrusion-color": [
                "match",
                ["get", "id"],
                selectedRnbBuilding?.building.rnbId ?? "__none__",
                "#14b8a6",
                "#c8ccd2",
              ],
              "fill-extrusion-height": ["coalesce", ["get", "height"], 12],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.85,
            }}
          />
        </Source>
        <MapLibre3DController active={mapLibre3D} mapRef={mapRef} />
        <WaypointBadgeAltitudeController active={mapLibre3D} mapRef={mapRef} />
        <AirspaceOverlay />

        {/* 2D overlays and interaction adapted for MapLibre */}
        <RnbBuildingsLayer2D
          enabled={showRnbLayer}
          buildings={rnbBuildings}
          selectedBuildingId={selectedRnbBuilding?.building.rnbId ?? null}
          onBuildingsChange={setRnbBuildings}
          onSelectBuilding={handleSelectRnbBuilding}
          mapRef={mapRef}
          lineWidth={mapLibre3D ? 4 : 2}
        />

        <MapInteraction2D
          mapRef={mapRef}
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
          isAddingWaypoint={isAddingWaypoint}
          isAddingPoi={isAddingPoi}
          isDrawingObstacle={isDrawingObstacle}
          drawingVertices={drawingVertices}
          addWaypoint={addWaypoint}
          addPoi={addPoi}
          addObstacle={addObstacle}
          setDrawingVertices={setDrawingVertices}
          selectObstacle={selectObstacle}
          onFacadeSegmentClick={handleFacadeSegmentClick}
        />

        {/* Waypoint markers (draggable, click to select) */}
        {waypoints.map((waypoint, i) => {
          const selected = selectedWaypointIndices.has(waypoint.index);
          return (
            <GLMarker
              key={`wp-${waypoint.index}`}
              longitude={waypoint.longitude}
              latitude={waypoint.latitude}
              anchor="center"
              draggable
              onDragEnd={(e: any) => {
                // En 3D le contenu du marqueur flotte au-dessus du sol :
                // l'utilisateur vise avec le rond, donc le curseur est en
                // dessous de la cible. On remonte le point lâché d'autant
                // pour un drop exact.
                let { lat, lng } = e.lngLat;
                try {
                  const map = mapRef.current?.getMap?.();
                  if (map && mapLibre3D) {
                    const offsetPx = waypointAltitudeOffsetPx(
                      map,
                      lat,
                      waypoint.height,
                    );
                    if (offsetPx > 0) {
                      const point = map.project({ lng, lat });
                      const adjusted = map.unproject({
                        x: point.x,
                        y: point.y - offsetPx,
                      });
                      lat = adjusted.lat;
                      lng = adjusted.lng;
                    }
                  }
                } catch {
                  // repli : coordonnées brutes
                }
                moveWaypoint(waypoint.index, lat, lng);
              }}
              onClick={(e: any) => {
                e.originalEvent.stopPropagation();
                selectWaypoint(
                  waypoint.index,
                  selectionModeFromEvent({
                    originalEvent: e.originalEvent,
                  }),
                );
              }}
            >
              <div
                title={`${waypoint.name}\nAlt: ${waypoint.height}m | Speed: ${waypoint.speed}m/s\nGimbal: ${waypoint.gimbalPitchAngle}°\n${waypoint.latitude.toFixed(6)}, ${waypoint.longitude.toFixed(6)}`}
                data-wp-index={waypoint.index}
                style={{
                  position: "relative",
                  width: 20,
                  height: 20,
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: "#3b82f6",
                    border: `2px solid ${selected ? "#ffffff" : "#1e40af"}`,
                    boxShadow: selected
                      ? "0 0 0 3px rgba(59,130,246,0.45), 0 1px 5px rgba(0,0,0,0.55)"
                      : "0 1px 4px rgba(0,0,0,0.5)",
                  }}
                />
                {/* Numéro collé au-dessus du rond (1px de recouvrement
                    pour fusionner visuellement badge et point) : visible à
                    tous les zooms, hors de la ligne de vol, contrasté sur
                    tous les fonds (plan comme satellite). */}
                <div
                  data-wp-badge="true"
                  style={{
                    position: "absolute",
                    bottom: 19,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "#3b82f6",
                    border: `2px solid ${selected ? "#ffffff" : "#1e40af"}`,
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 800,
                    borderRadius: 9,
                    padding: "2px 7px",
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    boxShadow: selected
                      ? "0 0 0 3px rgba(59,130,246,0.45), 0 1px 5px rgba(0,0,0,0.55)"
                      : "0 1px 5px rgba(0,0,0,0.55)",
                  }}
                >
                  {i + 1} · {formatHeight(waypoint.height, unitSystem)}
                </div>
              </div>
            </GLMarker>
          );
        })}

        {/* POI markers (draggable, ctrl+click aims selected waypoints) */}
        {pois.map((poi) => {
          const selected = selectedPoiId === poi.id;
          return (
            <GLMarker
              key={`poi-${poi.id}`}
              longitude={poi.longitude}
              latitude={poi.latitude}
              anchor="center"
              draggable
              onDragEnd={(e: any) =>
                movePoi(poi.id, e.lngLat.lat, e.lngLat.lng)
              }
              onClick={(e: any) => {
                e.originalEvent.stopPropagation();
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
            >
              <div
                title={`${poi.name}\nHeight: ${poi.height}m${ctrlHeld && selectedWaypointIndices.size > 0 ? "\nCtrl+click to aim selected waypoints here" : ""}`}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: selected ? "#ef4444" : "#0d9488",
                  border: `2px solid ${selected ? "#fca5a5" : "#fff"}`,
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                P
              </div>
            </GLMarker>
          );
        })}

        {/* Obstacle editing: draggable vertices + clickable midpoints */}
        {obstacles.map((obstacle) => {
          const isSelected = selectedObstacleId === obstacle.id;
          if (!isSelected) return null;
          const midpoints =
            obstacle.vertices.length >= 2
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
            <Fragment key={`obstacle-edit-${obstacle.id}`}>
              {obstacle.vertices.map(([lat, lng], vertexIndex) => (
                <GLMarker
                  key={`${obstacle.id}-vertex-${vertexIndex}`}
                  longitude={lng}
                  latitude={lat}
                  anchor="center"
                  draggable
                  onDragEnd={(e: any) =>
                    moveObstacleVertex(
                      obstacle.id,
                      vertexIndex,
                      e.lngLat.lat,
                      e.lngLat.lng,
                    )
                  }
                >
                  <div
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (obstacle.vertices.length > 3) {
                        removeObstacleVertex(obstacle.id, vertexIndex);
                      }
                    }}
                    title="Drag to move • right-click to remove"
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      background: "#ffffff",
                      border: "2px solid #ef4444",
                      cursor: "move",
                    }}
                  />
                </GLMarker>
              ))}
              {midpoints.map((midpoint) => (
                <GLMarker
                  key={`${obstacle.id}-mid-${midpoint.index}`}
                  longitude={midpoint.lng}
                  latitude={midpoint.lat}
                  anchor="center"
                  onClick={(e: any) => {
                    e.originalEvent.stopPropagation();
                    addObstacleVertex(
                      obstacle.id,
                      midpoint.index,
                      midpoint.lat,
                      midpoint.lng,
                    );
                  }}
                >
                  <div
                    title="Click to add vertex"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: "#fecaca",
                      border: "2px solid #ef4444",
                      cursor: "pointer",
                    }}
                  />
                </GLMarker>
              ))}
            </Fragment>
          );
        })}
        {drawingVertices.map(([lat, lng], index) => (
          <GLMarker
            key={`drawing-${index}`}
            longitude={lng}
            latitude={lat}
            anchor="center"
          >
            <div
              style={{
                width: index === 0 ? 14 : 10,
                height: index === 0 ? 14 : 10,
                borderRadius: index === 0 ? 7 : 5,
                background: index === 0 ? "#fca5a5" : "#ffffff",
                border: "2px solid #ef4444",
              }}
            />
          </GLMarker>
        ))}

        {/* Template preview waypoints + POIs */}
        {mapPreview?.waypoints.map((waypoint, index) => (
          <GLMarker
            key={`template-waypoint-${index}`}
            longitude={waypoint.longitude}
            latitude={waypoint.latitude}
            anchor="center"
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                background: "#7c3aed",
                border: "2px solid #c4b5fd",
                color: "#fff",
                fontSize: 9,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {index + 1}
            </div>
          </GLMarker>
        ))}
        {mapPreview?.pois.map((poi, index) => (
          <GLMarker
            key={`template-poi-${index}`}
            longitude={poi.longitude}
            latitude={poi.latitude}
            anchor="center"
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background: "#ef4444",
                border: "2px solid #fecaca",
              }}
            />
          </GLMarker>
        ))}

        {/* Selected RNB building centroid */}
        {showRnbLayer && selectedRnbCentroidPosition && (
          <GLMarker
            longitude={selectedRnbCentroidPosition.lng}
            latitude={selectedRnbCentroidPosition.lat}
            anchor="center"
          >
            <div
              title="Centroide batiment"
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background: "#111827",
                border: "2px solid #ffffff",
                color: "#fff",
                fontSize: 9,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              C
            </div>
          </GLMarker>
        )}
      </MapGL>

      <MapSearch
        value={searchValue}
        onValueChange={setSearchValue}
        onPick={handleSearchPick}
      />

      {templateMode && !templateConfirmed && (
        <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-border bg-background/95 px-4 py-2 text-xs text-muted-foreground shadow-lg">
          {templateMode === "pencil"
            ? "Click to add path points, then double-click or use Finish."
            : "Click once to set the start point, then click again to define the template."}
        </div>
      )}

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
                onClick={() => setSelectedBuildingScanMode("reconstruction-3d")}
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

      <MapTransientOverlays
        templateMode={templateMode}
        rawPath={rawPath}
        templateConfirmed={templateConfirmed}
        drawingVertices={drawingVertices}
        onFinishPencil={handleFinishPencil}
        onCancelPencil={handleCancelPencil}
        onFinishObstacle={handleFinishObstacle}
        onCancelObstacle={handleCancelObstacle}
        activeTemplateType={activeTemplateType}
        templatePreview={templatePreview}
        orbitParams={orbitParams}
        gridParams={gridParams}
        facadeParams={facadeParams}
        pencilParams={pencilParams}
        onOrbitChange={setOrbitParams}
        onGridChange={setGridParams}
        onFacadeChange={setFacadeParams}
        onPencilChange={setPencilParams}
        onApply={handleTemplateApply}
        onCancel={handleTemplateCancel}
        onFacadeAssist={handleFacadeAssist}
        onFacadeObjectiveChange={handleFacadeObjectiveChange}
        onReconstructionPresetSelect={handleReconstructionPresetSelect}
        onFacadeSegmentSelect={handleFacadeSegmentSelect}
        onFacadeVariantSelect={handleFacadeVariantSelect}
        facadeObjective={facadeObjective}
        facadeAssistBusy={facadeAssistBusy}
        facadeAssistMessage={facadeAssistMessage}
        facadeRecommendationBusy={facadeRecommendationBusy}
        facadeRecommendation={facadeRecommendation}
        reconstructionShell={reconstructionShell}
        reconstructionPresets={reconstructionPresets}
        facadeSegmentOptions={facadeSegmentOptions}
        selectedFacadeSegmentId={selectedFacadeSegmentId}
        facadeVariantOptions={facadeVariantOptions}
        selectedFacadeVariantId={selectedFacadeVariantId}
        pois={pois}
      />

      <MapViewChrome
        isSatellite={mapTypeId === HYBRID_TYPE}
        onSelectStreet={() => setMapTypeId(ROADMAP_TYPE)}
        onSelectSatellite={() => setMapTypeId(HYBRID_TYPE)}
        is3D={is3D}
        onSelect2D={() => setIs3D(false)}
        onSelect3D={handleSelect3D}
        showRnbLayer={showRnbLayer}
        onToggleRnbLayer={() => setShowRnbLayer((value) => !value)}
        showRnbEmptyHint={showRnbLayer && rnbBuildings.length === 0}
        scanOptionEnabled={selectedRnbBuilding != null}
        scanOptionDescription={
          selectedRnbBuilding
            ? "Ouvre le scan facade du bâtiment sélectionné"
            : "Sélectionnez un bâtiment sur la carte"
        }
        onScanOptionClick={openSelectedBuildingScanPanel}
        onClearAll={clearTransientMapUi}
      />
    </div>
  );
}
