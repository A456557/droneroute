import { useCallback, useEffect, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";
import { buildingApi, type RnbBuilding } from "@/lib/api";
import { PolygonOverlay } from "./googleMapOverlays";

interface RnbBuildingsLayerProps {
  enabled: boolean;
  buildings: RnbBuilding[];
  selectedBuildingId: string | null;
  onBuildingsChange: (buildings: RnbBuilding[]) => void;
  onSelectBuilding: (
    building: RnbBuilding,
    position: google.maps.LatLngLiteral,
  ) => void;
}

export function RnbBuildingsLayer({
  enabled,
  buildings,
  selectedBuildingId,
  onBuildingsChange,
  onSelectBuilding,
}: RnbBuildingsLayerProps) {
  const map = useMap();
  const requestIdRef = useRef(0);

  const fetchForBounds = useCallback(
    async (south: number, west: number, north: number, east: number) => {
      const requestId = ++requestIdRef.current;
      try {
        const response = await buildingApi.listRnbBuildings([
          west,
          south,
          east,
          north,
        ]);
        if (requestId === requestIdRef.current) {
          onBuildingsChange(response.buildings);
        }
      } catch {
        if (requestId === requestIdRef.current) {
          onBuildingsChange([]);
        }
      }
    },
    [onBuildingsChange],
  );

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
      {buildings.map((building) => {
        const isSelected = building.rnbId === selectedBuildingId;
        return (
          <PolygonOverlay
            key={building.rnbId}
            path={building.footprint}
            strokeColor={isSelected ? "#06b6d4" : "#0ea5e9"}
            strokeOpacity={isSelected ? 0.95 : 0.7}
            strokeWeight={isSelected ? 2 : 1}
            fillColor={isSelected ? "#22d3ee" : "#38bdf8"}
            fillOpacity={isSelected ? 0.16 : 0.08}
            clickable
            zIndex={isSelected ? 160 : 150}
            onClick={(position) => onSelectBuilding(building, position)}
          />
        );
      })}
    </>
  );
}
