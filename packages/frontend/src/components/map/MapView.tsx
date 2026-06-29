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
import { useMissionStore } from "@/store/missionStore";
import { useConfigStore } from "@/store/configStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAirspaceStore } from "@/store/airspaceStore";
import { getObstacleWarnings } from "@/lib/geo";
import {
  buildingApi,
  type FacadeCopilotObjective,
  type DetectedBuilding,
  type FacadeCopilotRecommendation,
} from "@/lib/api";
import {
  DEFAULT_FACADE_PARAMS,
  DEFAULT_GRID_PARAMS,
  DEFAULT_ORBIT_PARAMS,
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

const MIN_PENCIL_PATH_LENGTH_M = 10;
const ROADMAP_TYPE = "roadmap" as google.maps.MapTypeId;
const HYBRID_TYPE = "hybrid" as google.maps.MapTypeId;

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
  detectedBuilding: DetectedBuilding | null;
  selectedSegment: FacadeSegmentOption | null;
  facadeParams: FacadeParams | null;
  selectedWaypoint:
    | ReturnType<typeof useMissionStore.getState>["waypoints"][number]
    | null;
  selectedWaypointHeading: number | null;
  defaultMapView: { latitude: number; longitude: number; zoom: number };
}): Buildings3DView {
  const {
    detectedBuilding,
    selectedSegment,
    facadeParams,
    selectedWaypoint,
    selectedWaypointHeading,
    defaultMapView,
  } = args;

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

function segmentMidpoint(segment: FacadeSegmentOption): LatLng {
  return {
    lat: (segment.start.lat + segment.end.lat) / 2,
    lng: (segment.start.lng + segment.end.lng) / 2,
  };
}

function Buildings3DPanel({
  open,
  view,
  detectedBuilding,
  selectedSegment,
  facadeRecommendation,
  onClose,
}: {
  open: boolean;
  view: Buildings3DView;
  detectedBuilding: DetectedBuilding | null;
  selectedSegment: FacadeSegmentOption | null;
  facadeRecommendation: FacadeCopilotRecommendation | null;
  onClose: () => void;
}) {
  if (!open) return null;

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

  return (
    <div className="absolute right-4 top-4 z-20 flex h-[360px] w-[min(520px,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-sm">
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
          Close
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
        {markers.length > 0 && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[250px] rounded-md border border-border/80 bg-background/88 px-3 py-2 text-[10px] shadow-lg backdrop-blur-sm">
            <p className="font-medium text-foreground">3D mission markers</p>
            {markers.map((marker) => (
              <p key={marker.id} className="text-muted-foreground">
                {marker.glyph}: {marker.label}
              </p>
            ))}
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

        if (isAddingWaypoint) {
          addWaypoint(point[0], point[1]);
          return;
        }

        if (isAddingPoi) addPoi(point[0], point[1]);
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

  const [mapTypeId, setMapTypeId] = useState<google.maps.MapTypeId>(
    vizPrefs?.mapStyle === "street" ? ROADMAP_TYPE : HYBRID_TYPE,
  );
  const [is3D, setIs3D] = useState(vizPrefs?.viewMode === "3d");
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
  const [showBuildings3D, setShowBuildings3D] = useState(false);

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

  const buildings3DView = useMemo(
    () =>
      buildBuildings3DView({
        detectedBuilding,
        selectedSegment: selectedFacadeSegment,
        facadeParams,
        selectedWaypoint: singleSelectedWaypoint,
        selectedWaypointHeading: singleSelectedWaypoint
          ? resolveWaypointHeading(singleSelectedWaypoint, pois)
          : null,
        defaultMapView,
      }),
    [
      defaultMapView,
      detectedBuilding,
      facadeParams,
      pois,
      selectedFacadeSegment,
      singleSelectedWaypoint,
    ],
  );

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
    setFacadeAssistSeedParams(null);
    setFacadeSegmentOptions([]);
    setSelectedFacadeSegmentId(null);
    setFacadeVariantOptions([]);
    setSelectedFacadeVariantId(null);
    setFacadeAssistBusy(false);
    setFacadeAssistMessage(null);
    setFacadeRecommendation(null);
    setFacadeRecommendationBusy(false);
  }, []);

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

  const handleFacadeAssist = useCallback(async () => {
    if (!facadeParams) return;

    const lat = (facadeParams.point1[0] + facadeParams.point2[0]) / 2;
    const lng = (facadeParams.point1[1] + facadeParams.point2[1]) / 2;

    setFacadeAssistBusy(true);
    setFacadeAssistMessage("Searching for the nearest building footprint...");

    try {
      const seedParams = { ...facadeParams };
      const response = await buildingApi.detectNearest({
        lat,
        lng,
        radiusM: Math.max(60, facadeParams.distanceM * 4),
      });
      const scenario = applyFacadeScenario(response.building, seedParams);
      if (!scenario) {
        throw new Error("Detected building has no usable facade segment");
      }

      const recommendation = await refreshFacadeRecommendation(
        response.building,
        scenario,
      );

      setFacadeAssistMessage(
        recommendation
          ? `${response.building.source.toUpperCase()} footprint detected. Copilot recommends ${recommendation.recommendedVariantLabel.toLowerCase()} at ${Math.round(recommendation.confidence * 100)}% confidence.`
          : `${response.building.source.toUpperCase()} footprint detected, ${scenario.segments.length} facades ranked, ${scenario.selectedVariant.label.toLowerCase()} variant selected at ${(scenario.selectedVariant.score * 100).toFixed(0)}%.`,
      );
    } catch (error) {
      setDetectedBuilding(null);
      setFacadeSegmentOptions([]);
      setSelectedFacadeSegmentId(null);
      setFacadeVariantOptions([]);
      setSelectedFacadeVariantId(null);
      setFacadeRecommendation(null);
      setFacadeAssistMessage(
        error instanceof Error ? error.message : "Failed to auto-fit building",
      );
    } finally {
      setFacadeAssistBusy(false);
    }
  }, [applyFacadeScenario, facadeParams]);

  useEffect(() => {
    resetTemplateState();
  }, [templateMode, resetTemplateState]);

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
          />
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

          {templatePreview?.waypoints.slice(0, -1).map((waypoint, index) => {
            const next = templatePreview.waypoints[index + 1];
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

          {templatePreview?.waypoints.map((waypoint, index) => (
            <MarkerOverlay
              key={`template-waypoint-${index}`}
              position={toLatLng(waypoint.latitude, waypoint.longitude)}
              label={`${index + 1}`}
              fillColor="#7c3aed"
              strokeColor="#c4b5fd"
              scale={8}
            />
          ))}

          {templatePreview?.pois.map((poi, index) => (
            <MarkerOverlay
              key={`template-poi-${index}`}
              position={toLatLng(poi.latitude, poi.longitude)}
              fillColor="#ef4444"
              strokeColor="#fecaca"
              scale={7}
              iconPath="arrow"
            />
          ))}
        </Map>

        <MapSearch value={searchValue} onValueChange={setSearchValue} />

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
                  resetTemplateState();
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
              resetTemplateState();
              setTemplateMode(null);
            }}
            onCancel={() => {
              resetTemplateState();
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
          open={showBuildings3D}
          view={buildings3DView}
          detectedBuilding={detectedBuilding}
          selectedSegment={selectedFacadeSegment}
          facadeRecommendation={facadeRecommendation}
          onClose={() => setShowBuildings3D(false)}
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
            onClick={() => setIs3D(false)}
          >
            2D
          </button>
          <button
            className={`px-2 py-1 text-xs rounded ${is3D ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => {
              setIs3D(true);
              setShowBuildings3D(true);
            }}
          >
            3D
          </button>
          <div className="w-px bg-border mx-1" />
          <button
            className={`px-2 py-1 text-xs rounded ${showBuildings3D ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground border border-border"}`}
            onClick={() => setShowBuildings3D((value) => !value)}
          >
            Buildings 3D
          </button>
        </div>

        <MapToolbar />
      </div>
    </APIProvider>
  );
}
