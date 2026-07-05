import React, { useEffect, useRef, useMemo } from "react";
import mapboxgl from "mapbox-gl";
import MapGL, {
  Marker as GLMarker,
  Popup,
  Source,
  Layer,
} from "react-map-gl/mapbox";
import { buildingApi, type RnbBuilding } from "@/lib/api";
import { haversineDistance } from "@/lib/geo";
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

// Marker overlay for Mapbox
export function MarkerOverlay2D({
  position,
  title,
  label,
  fillColor = "#2563eb",
  strokeColor = "#bfdbfe",
  scale = 8,
  draggable = false,
  onClick,
  onDragEnd,
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
  path,
  strokeColor = "#2563eb",
  strokeWidth = 3,
  onClick,
}: any) {
  const geojson = useMemo(
    () => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: path.map((p: any) => [
          p.lng ?? p.longitude ?? p[1],
          p.lat ?? p.latitude ?? p[0],
        ]),
      },
    }),
    [path],
  );
  return (
    <Source
      id={"polyline-" + Math.random().toString(36).slice(2)}
      type="geojson"
      data={geojson}
    >
      <Layer
        id={"polyline-layer-" + Math.random().toString(36).slice(2)}
        type="line"
        paint={{ "line-color": strokeColor, "line-width": strokeWidth }}
      />
    </Source>
  );
}

export function PolygonOverlay2D({
  path,
  strokeColor = "#ef4444",
  fillColor = "#ef4444",
  fillOpacity = 0.15,
  onClick,
}: any) {
  const coords = [
    path.map((p: any) => [
      p.lng ?? p.longitude ?? p[1],
      p.lat ?? p.latitude ?? p[0],
    ]),
  ];
  const geojson = useMemo(
    () => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: coords },
    }),
    [path],
  );
  return (
    <Source
      id={"polygon-" + Math.random().toString(36).slice(2)}
      type="geojson"
      data={geojson}
    >
      <Layer
        id={"polygon-layer-fill-" + Math.random().toString(36).slice(2)}
        type="fill"
        paint={{ "fill-color": fillColor, "fill-opacity": fillOpacity }}
      />
      <Layer
        id={"polygon-layer-line-" + Math.random().toString(36).slice(2)}
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
      } catch (e) {
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
          path={building.footprint}
          strokeColor={
            building.rnbId === selectedBuildingId ? "#06b6d4" : "#0ea5e9"
          }
          fillColor={
            building.rnbId === selectedBuildingId ? "#22d3ee" : "#38bdf8"
          }
          fillOpacity={0.12}
          onClick={() =>
            onSelectBuilding(building, {
              lat: building.centroid.lat,
              lng: building.centroid.lng,
            })
          }
        />
      ))}
    </>
  );
}

export function MapInteraction2D({
  mapRef,
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
}: any) {
  useEffect(() => {
    const map = mapRef?.current?.getMap
      ? mapRef.current.getMap()
      : mapRef?.current;
    if (!map) return;

    function toPoint(e: any) {
      const lngLat = e.lngLat ||
        e.lngLat || { lng: e.lngLat?.lng, lat: e.lngLat?.lat };
      return [lngLat.lat, lngLat.lng] as [number, number];
    }

    const clickHandler = (e: any) => {
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

      if (rnbSelectionEnabled) {
        // simple point-in-polygon search
        const selected = rnbBuildings.find((b: any) => {
          // centroid distance heuristic
          const dist = Math.hypot(
            b.centroid.lat - point[0],
            b.centroid.lng - point[1],
          );
          return dist < 0.002; // ~200m heuristic
        });
        if (selected) {
          onSelectRnbBuilding(selected, { lat: point[0], lng: point[1] });
          return;
        }
      }

      // add waypoint / poi handled elsewhere by mission store usage
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
    };

    map.on("click", clickHandler);
    map.on("mousemove", moveHandler);
    map.on("dblclick", dblHandler);

    return () => {
      map.off("click", clickHandler);
      map.off("mousemove", moveHandler);
      map.off("dblclick", dblHandler);
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
  ]);

  return null;
}
