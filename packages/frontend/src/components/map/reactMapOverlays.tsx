import React, { useEffect, useMemo, useId } from "react";
import {
  Marker as GLMarker,
  Popup,
  Source,
  Layer,
} from "react-map-gl/maplibre";
import { buildingApi, type RnbBuilding } from "@/lib/api";
import { haversineDistance, pointInPolygon } from "@/lib/geo";
const haversine = haversineDistance;

// Minimal SVG pin builder reused
function buildSvgContent(opts: {
  fillColor: string;
  strokeColor: string;
  scale?: number;
  label?: string;
}) {
  const { fillColor, strokeColor, scale = 10, label } = opts;
  const size = scale * 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      style={{ display: "block" }}
    >
      <circle
        cx="10"
        cy="10"
        r="9"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth="2"
      />
      {label && (
        <text
          x="10"
          y="14"
          textAnchor="middle"
          fill="#ffffff"
          fontSize="9"
          fontWeight="700"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

// Stable per-instance id for MapLibre sources/layers. react-map-gl throws
// "source id changed" if the id of a mounted Source ever changes, so random
// ids (regenerated on every render) crash the whole map.
function useStableLayerId(prefix: string, explicitId?: string): string {
  const generated = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return useMemo(
    () => explicitId ?? `${prefix}-${generated}`,
    [explicitId, prefix, generated],
  );
}

// Marker overlay for Mapbox
export function MarkerOverlay2D({
  position,
  label,
  fillColor = "#2563eb",
  strokeColor = "#bfdbfe",
  scale = 8,
  onClick,
}: any) {
  const [lng, lat] = [
    position.lng ?? position.longitude ?? position[1] ?? 0,
    position.lat ?? position.latitude ?? position[0] ?? 0,
  ];
  return (
    <GLMarker longitude={lng} latitude={lat} anchor="center">
      <div onClick={onClick} style={{ cursor: onClick ? "pointer" : "auto" }}>
        {buildSvgContent({ fillColor, strokeColor, scale, label })}
      </div>
    </GLMarker>
  );
}

export function PopupOverlay2D({ position, content, onClose }: any) {
  const [lng, lat] = [
    position.lng ?? position.longitude ?? position[1],
    position.lat ?? position.latitude ?? position[0],
  ];
  return (
    <Popup longitude={lng} latitude={lat} onClose={onClose} closeButton>
      <div dangerouslySetInnerHTML={{ __html: content }} />
    </Popup>
  );
}

export function PolylineOverlay2D({
  id,
  path,
  strokeColor = "#2563eb",
  strokeWidth = 3,
}: any) {
  const baseId = useStableLayerId("polyline", id);
  const geojson = useMemo(
    () => ({
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "LineString" as const,
        coordinates: path.map((p: any) => [
          p.lng ?? p.longitude ?? p[1],
          p.lat ?? p.latitude ?? p[0],
        ]),
      },
    }),
    [path],
  );
  return (
    <Source id={baseId} type="geojson" data={geojson}>
      <Layer
        id={`${baseId}-line`}
        type="line"
        paint={{ "line-color": strokeColor, "line-width": strokeWidth }}
      />
    </Source>
  );
}

export function PolygonOverlay2D({
  id,
  path,
  strokeColor = "#ef4444",
  fillColor = "#ef4444",
  fillOpacity = 0.15,
}: any) {
  const baseId = useStableLayerId("polygon", id);
  const coords = [
    path.map((p: any) => [
      p.lng ?? p.longitude ?? p[1],
      p.lat ?? p.latitude ?? p[0],
    ]),
  ];
  const geojson = useMemo(
    () => ({
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Polygon" as const, coordinates: coords },
    }),
    [path],
  );
  return (
    <Source id={baseId} type="geojson" data={geojson}>
      <Layer
        id={`${baseId}-fill`}
        type="fill"
        paint={{ "fill-color": fillColor, "fill-opacity": fillOpacity }}
      />
      <Layer
        id={`${baseId}-line`}
        type="line"
        paint={{ "line-color": strokeColor, "line-width": 2 }}
      />
    </Source>
  );
}

export function RnbBuildingsLayer2D({
  enabled,
  buildings,
  selectedBuildingId,
  onBuildingsChange,
  onSelectBuilding,
  mapRef,
}: any) {
  useEffect(() => {
    if (!enabled || !mapRef?.current) return;
    let cancelled = false;
    const map = mapRef.current.getMap
      ? mapRef.current.getMap()
      : mapRef.current;
    async function refresh() {
      try {
        const bounds = map.getBounds();
        const west = bounds.getWest();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const north = bounds.getNorth();
        const response = await buildingApi.listRnbBuildings([
          west,
          south,
          east,
          north,
        ]);
        if (!cancelled) onBuildingsChange(response.buildings);
      } catch {
        if (!cancelled) onBuildingsChange([]);
      }
    }
    refresh();
    const onMove = () => refresh();
    map.on("moveend", onMove);
    return () => {
      cancelled = true;
      map.off("moveend", onMove);
    };
  }, [enabled, mapRef, onBuildingsChange]);

  if (!enabled) return null;

  return (
    <>
      {buildings.map((building: RnbBuilding) => (
        <PolygonOverlay2D
          key={building.rnbId}
          id={`rnb-${building.rnbId}`}
          path={building.footprint}
          strokeColor={
            building.rnbId === selectedBuildingId ? "#06b6d4" : "#0ea5e9"
          }
          fillColor={
            building.rnbId === selectedBuildingId ? "#22d3ee" : "#38bdf8"
          }
          fillOpacity={0.12}
          onClick={() => {
            const center =
              building.centroid ?? building.point ?? building.footprint?.[0];
            if (!center || typeof center.lat !== "number") return;
            onSelectBuilding(building, {
              lat: center.lat,
              lng: center.lng,
            });
          }}
        />
      ))}
    </>
  );
}

// Active le relief 3D (terrain + caméra inclinée) sur la vue MapLibre
// open-source quand `active` est vrai.
// - Visualisation : tuiles Terrarium (MNT mondial, sans clé).
// - Altitudes chantier précises (France) : MNT IGN RGE ALTI / LiDAR HD via
//   le proxy backend /api/terrain (Géoplateforme, Licence Ouverte), utilisé
//   pour le drapage AGL constant et l'analyse IA (voir lib/terrain.ts).
//   Le MNT IGN WMTS n'est pas encodé Terrarium/Mapbox donc pas utilisable
//   directement comme raster-dem MapLibre.
export function MapLibre3DController({
  active,
  mapRef,
}: {
  active: boolean;
  mapRef: any;
}) {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      if (cancelled) return;
      try {
        const map = mapRef?.current?.getMap ? mapRef.current.getMap() : null;
        if (!map || typeof map.addSource !== "function") {
          timer = setTimeout(apply, 300);
          return;
        }
        if (active) {
          if (!map.getSource("terrain-dem")) {
            map.addSource("terrain-dem", {
              type: "raster-dem",
              tiles: [
                "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
              ],
              tileSize: 256,
              maxzoom: 15,
              encoding: "terrarium",
            });
          }
          map.setTerrain({ source: "terrain-dem", exaggeration: 1.4 });
          map.easeTo({ pitch: 60, duration: 800 });
        } else {
          try {
            if (map.getTerrain && map.getTerrain()) map.setTerrain(null);
          } catch {
            // terrain was never set
          }
          if (typeof map.getPitch === "function" && map.getPitch() !== 0) {
            map.easeTo({ pitch: 0, duration: 800 });
          }
        }
      } catch {
        timer = setTimeout(apply, 300);
      }
    };
    apply();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, mapRef]);

  return null;
}

export function MapInteraction2D({
  mapRef,
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
  isAddingWaypoint,
  isAddingPoi,
  isDrawingObstacle,
  drawingVertices,
  addWaypoint,
  addPoi,
  addObstacle,
  setDrawingVertices,
  selectObstacle,
  onFacadeSegmentClick,
}: any) {
  useEffect(() => {
    const map = mapRef?.current?.getMap
      ? mapRef.current.getMap()
      : mapRef?.current;
    if (!map) return;

    const clickHandler = (e: any) => {
      // Layer clicks (obstacle polygons, facade segments) are handled by
      // dedicated handlers below — ignore them here.
      const clickableLayers = ["obstacles-fill", "facade-segments-line"].filter(
        (id) => typeof map.getLayer === "function" && map.getLayer(id),
      );
      if (clickableLayers.length > 0) {
        try {
          const hits = map.queryRenderedFeatures(e.point, {
            layers: clickableLayers,
          });
          if (hits && hits.length > 0) return;
        } catch {
          // layer not ready yet, fall through to generic handling
        }
      }

      const point: [number, number] = [e.lngLat.lat, e.lngLat.lng];

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
            center: nextState.start,
            radiusM: Math.round(distance),
            numPoints: 12,
            clockwise: true,
            createPoi: true,
            altitude: 30,
          });
        } else if (templateMode === "grid") {
          setGridParams({
            corner1: nextState.start,
            corner2: nextState.end,
            altitude: 30,
            spacingM: 30,
            addPhotos: true,
            crosshatch: false,
            gimbalPitchAngle: -90,
            rotationDeg: 0,
            reverse: false,
          });
        } else {
          setFacadeParams({
            point1: nextState.start,
            point2: nextState.end,
            distanceM: 20,
            minAltitude: 1,
            maxAltitude: 30,
            numRows: 4,
            numColumns: 8,
            addPhotos: true,
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
        // Exact footprint hit first so clicks anywhere on a visible
        // polygon select it, then nearest centroid within ~200 m.
        const inFootprint = rnbBuildings.find((b: any) => {
          const fp = b.footprint;
          if (!Array.isArray(fp) || fp.length < 3) return false;
          try {
            return pointInPolygon(
              point,
              fp.map((p: any) => [p.lat, p.lng] as [number, number]),
            );
          } catch {
            return false;
          }
        });
        let selected = inFootprint ?? null;
        if (!selected) {
          let bestDist = 0.002; // ~200m heuristic
          for (const b of rnbBuildings) {
            const center = b.centroid ?? b.point ?? b.footprint?.[0];
            if (!center || typeof center.lat !== "number") continue;
            const dist = Math.hypot(
              center.lat - point[0],
              center.lng - point[1],
            );
            if (dist < bestDist) {
              bestDist = dist;
              selected = b;
            }
          }
        }
        if (selected) {
          onSelectRnbBuilding(selected, { lat: point[0], lng: point[1] });
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
    };

    const moveHandler = (e: any) => {
      if (!dragState) return;
      setDragState({
        start: dragState.start,
        end: [e.lngLat.lat, e.lngLat.lng],
      });
    };

    const dblHandler = () => {
      if (templateMode === "pencil" && rawPath.length >= 2) {
        // nothing special here, higher-level code will handle
      }
      if (isDrawingObstacle && drawingVertices.length >= 3) {
        addObstacle(drawingVertices);
      }
    };

    map.on("click", clickHandler);
    map.on("mousemove", moveHandler);
    map.on("dblclick", dblHandler);

    const obstacleClick = (e: any) => {
      const id = e.features?.[0]?.properties?.id;
      if (id && selectObstacle) selectObstacle(id);
    };
    const segmentClick = (e: any) => {
      const id = e.features?.[0]?.properties?.id;
      if (id && onFacadeSegmentClick) onFacadeSegmentClick(id);
    };
    map.on("click", "obstacles-fill", obstacleClick);
    map.on("click", "facade-segments-line", segmentClick);

    return () => {
      map.off("click", clickHandler);
      map.off("mousemove", moveHandler);
      map.off("dblclick", dblHandler);
      map.off("click", "obstacles-fill", obstacleClick);
      map.off("click", "facade-segments-line", segmentClick);
    };
  }, [
    mapRef,
    templateMode,
    dragState,
    rawPath,
    setDragState,
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
    isAddingWaypoint,
    isAddingPoi,
    isDrawingObstacle,
    drawingVertices,
    addWaypoint,
    addPoi,
    addObstacle,
    setDrawingVertices,
    selectObstacle,
    onFacadeSegmentClick,
  ]);

  return null;
}
