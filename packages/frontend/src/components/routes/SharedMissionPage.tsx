import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { formatDistance } from "@/lib/units";
import {
  MapPin,
  Crosshair,
  Route,
  ArrowUp,
  Plane,
  Calendar,
  Download,
  Copy,
  User,
  ArrowLeft,
} from "lucide-react";
import MapGL, {
  Source,
  Layer,
  Marker as GLMarker,
} from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { Button } from "@/components/ui/button";
import { useMissionStore } from "@/store/missionStore";
import { useAuthStore } from "@/store/authStore";
import { api } from "@/lib/api";
import { DRONE_MODELS } from "@droneroute/shared";
import { getObstacleWarnings } from "@/lib/geo";
import type {
  Waypoint,
  MissionConfig,
  PointOfInterest,
  Obstacle,
} from "@droneroute/shared";

interface SharedMissionData {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  shareToken: string;
  ownerEmail?: string;
  config: MissionConfig;
  waypoints: Waypoint[];
  pois: PointOfInterest[];
  obstacles: Obstacle[];
}

function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateDistance(waypoints: Waypoint[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += haversine(
      waypoints[i - 1].latitude,
      waypoints[i - 1].longitude,
      waypoints[i].latitude,
      waypoints[i].longitude,
    );
  }
  return total;
}

function estimateFlightTime(waypoints: Waypoint[]): number {
  let seconds = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const dist = haversine(
      waypoints[i - 1].latitude,
      waypoints[i - 1].longitude,
      waypoints[i].latitude,
      waypoints[i].longitude,
    );
    seconds += dist / (waypoints[i - 1].speed || 7);
  }
  return Math.round(seconds);
}

function formatFlightTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function getDroneLabel(config: MissionConfig): string | null {
  const model = DRONE_MODELS.find(
    (d) =>
      d.droneEnumValue === config.droneEnumValue &&
      d.droneSubEnumValue === config.droneSubEnumValue,
  );
  return model?.label ?? null;
}

interface SharedMissionPageProps {
  shareToken: string;
  onRequestAuth: () => void;
}

/** Read-only map preview showing the flight path, waypoints, POIs, and obstacle polygons. */
function SharedMissionMap({
  waypoints,
  pois,
  obstacles,
}: {
  waypoints: Waypoint[];
  pois: PointOfInterest[];
  obstacles: Obstacle[];
}) {
  const warnings = useMemo(
    () => getObstacleWarnings(waypoints, obstacles),
    [waypoints, obstacles],
  );
  const warningSegments = useMemo(() => {
    const set = new Set<number>();
    for (const w of warnings) {
      if (w.type === "crosses") set.add(w.waypointIndex);
    }
    return set;
  }, [warnings]);

  const center: [number, number] =
    waypoints.length > 0
      ? [waypoints[0].longitude, waypoints[0].latitude]
      : [2.1686, 41.3874];

  const flightGeo = useMemo(() => {
    const normal: [number, number][][] = [];
    const warned: [number, number][][] = [];
    waypoints.slice(0, -1).forEach((wp, i) => {
      const next = waypoints[i + 1];
      const segment: [number, number][] = [
        [wp.longitude, wp.latitude],
        [next.longitude, next.latitude],
      ];
      if (warningSegments.has(wp.index)) warned.push(segment);
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

  const obstaclesGeo = useMemo(
    () =>
      ({
        type: "FeatureCollection",
        features: obstacles
          .filter((o) => o.vertices.length >= 3)
          .map((o) => {
            const ring = o.vertices.map(([lat, lng]): [number, number] => [
              lng,
              lat,
            ]);
            ring.push(ring[0]);
            return {
              type: "Feature",
              properties: { id: o.id },
              geometry: { type: "Polygon", coordinates: [ring] },
            };
          }),
      }) as GeoJSON.FeatureCollection<GeoJSON.Geometry>,
    [obstacles],
  );

  return (
    <div className="h-[360px] w-full rounded-lg overflow-hidden border border-border">
      <MapGL
        initialViewState={{
          longitude: center[0],
          latitude: center[1],
          zoom: 14,
        }}
        // See MapView: react-map-gl v8 types target maplibre v5 (GlobeControl).
        mapLib={maplibregl as any}
        mapStyle="https://tiles.openfreemap.org/styles/bright"
        style={{ width: "100%", height: "100%" }}
      >
        <Source
          id="shared-flight-normal"
          type="geojson"
          data={flightGeo.normal}
        >
          <Layer
            id="shared-flight-normal-line"
            type="line"
            paint={{
              "line-color": "#3b82f6",
              "line-width": 3,
              "line-opacity": 0.85,
            }}
          />
        </Source>
        <Source
          id="shared-flight-warned"
          type="geojson"
          data={flightGeo.warned}
        >
          <Layer
            id="shared-flight-warned-line"
            type="line"
            paint={{
              "line-color": "#ef4444",
              "line-width": 3,
              "line-opacity": 0.85,
            }}
          />
        </Source>

        <Source id="shared-obstacles" type="geojson" data={obstaclesGeo}>
          <Layer
            id="shared-obstacles-fill"
            type="fill"
            paint={{ "fill-color": "#ef4444", "fill-opacity": 0.12 }}
          />
          <Layer
            id="shared-obstacles-outline"
            type="line"
            paint={{ "line-color": "#ef4444", "line-width": 2 }}
          />
        </Source>

        {waypoints.map((wp, i) => (
          <GLMarker
            key={`shared-wp-${wp.index}`}
            longitude={wp.longitude}
            latitude={wp.latitude}
            anchor="center"
          >
            <div
              title={`${wp.name}\nAlt: ${wp.height}m`}
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background:
                  i === 0
                    ? "#22c55e"
                    : i === waypoints.length - 1
                      ? "#ef4444"
                      : "#3b82f6",
                border: "2px solid #bfdbfe",
              }}
            />
          </GLMarker>
        ))}

        {pois.map((poi) => (
          <GLMarker
            key={`shared-poi-${poi.id}`}
            longitude={poi.longitude}
            latitude={poi.latitude}
            anchor="center"
          >
            <div
              title={`${poi.name}\nHeight: ${poi.height}m`}
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                background: "#f59e0b",
                border: "2px solid #fcd34d",
              }}
            />
          </GLMarker>
        ))}
      </MapGL>
    </div>
  );
}

export function SharedMissionPage({
  shareToken,
  onRequestAuth,
}: SharedMissionPageProps) {
  const { loadMission, setCurrentPage } = useMissionStore();
  const { token } = useAuthStore();
  const [mission, setMission] = useState<SharedMissionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    const fetchShared = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.get<SharedMissionData>(`/shared/${shareToken}`);
        setMission(data);
      } catch (e: any) {
        setError(e.message || "Mission not found");
      } finally {
        setLoading(false);
      }
    };
    fetchShared();
  }, [shareToken]);

  const handleLoadReadOnly = () => {
    if (!mission) return;
    loadMission({
      name: mission.name,
      config: mission.config,
      waypoints: mission.waypoints,
      pois: mission.pois,
      obstacles: mission.obstacles,
    });
    window.history.pushState({}, "", "/");
    setCurrentPage("editor");
  };

  const handleClone = async () => {
    if (!token) {
      onRequestAuth();
      return;
    }
    setCloning(true);
    try {
      const result = await api.post<{ id: string; name: string }>(
        `/shared/${shareToken}/clone`,
      );
      if (!mission) return;
      loadMission({
        id: result.id,
        name: result.name,
        config: mission.config,
        waypoints: mission.waypoints,
        pois: mission.pois,
        obstacles: mission.obstacles,
      });
      window.history.pushState({}, "", "/");
      setCurrentPage("editor");
    } catch (e: any) {
      toast.error("Clone failed: " + (e.message || "Unknown error"));
    } finally {
      setCloning(false);
    }
  };

  const handleExportKmz = async () => {
    if (!mission || mission.waypoints.length < 2) return;
    try {
      const blob = await api.post<Blob>("/kmz/generate", {
        name: mission.name,
        config: mission.config,
        waypoints: mission.waypoints,
        pois: mission.pois,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(mission.name || "mission").replace(/[^a-zA-Z0-9_-]/g, "_")}.kmz`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(`Export failed: ${err.message}`);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center justify-between max-w-3xl mx-auto">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  window.history.pushState({}, "", "/");
                  setCurrentPage("editor");
                }}
                className="h-9 w-9"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                  <Route className="h-5 w-5 text-primary" />
                  Shared route
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Someone shared a drone mission with you
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto">
            {loading && (
              <div className="flex items-center justify-center py-20 text-muted-foreground">
                <div className="text-center">
                  <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-3" />
                  <p className="text-sm">Loading shared route...</p>
                </div>
              </div>
            )}

            {!loading && error && (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Route className="h-12 w-12 mb-4 opacity-30" />
                <p className="text-lg font-medium mb-1">Route not found</p>
                <p className="text-sm mb-4">
                  This shared link may have expired or been revoked
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.history.pushState({}, "", "/");
                    setCurrentPage("editor");
                  }}
                >
                  Go to editor
                </Button>
              </div>
            )}

            {!loading &&
              !error &&
              mission &&
              (() => {
                const dist = estimateDistance(mission.waypoints);
                const flightTime = estimateFlightTime(mission.waypoints);
                const droneLabel = getDroneLabel(mission.config);
                const maxAlt =
                  mission.waypoints.length > 0
                    ? Math.max(...mission.waypoints.map((w) => w.height))
                    : 0;

                return (
                  <div className="bg-card border border-border rounded-lg overflow-hidden">
                    {/* Gradient header */}
                    <div className="h-2 bg-gradient-to-r from-emerald-500 via-blue-500 to-purple-500" />

                    <div className="p-6">
                      {/* Mission name */}
                      <h2 className="text-2xl font-bold text-foreground mb-2">
                        {mission.name || "Untitled route"}
                      </h2>

                      {/* Owner + date */}
                      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-6">
                        {mission.ownerEmail && (
                          <span className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5" />
                            {mission.ownerEmail}
                          </span>
                        )}
                        <span className="flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5" />
                          {formatDate(mission.updatedAt || mission.createdAt)}
                        </span>
                      </div>

                      {/* Stats grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                        {droneLabel && (
                          <div className="bg-background rounded-lg p-3 border border-border">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                              <Plane className="h-3 w-3 text-purple-400" />
                              Drone
                            </div>
                            <div className="text-sm font-medium text-foreground">
                              {droneLabel}
                            </div>
                          </div>
                        )}
                        <div className="bg-background rounded-lg p-3 border border-border">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                            <MapPin className="h-3 w-3 text-blue-400" />
                            Waypoints
                          </div>
                          <div className="text-sm font-medium text-foreground">
                            {mission.waypoints.length}
                            {mission.pois.length > 0 && (
                              <span className="text-xs text-muted-foreground ml-1">
                                + {mission.pois.length} POI
                              </span>
                            )}
                          </div>
                        </div>
                        {dist > 0 && (
                          <div className="bg-background rounded-lg p-3 border border-border">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                              <Route className="h-3 w-3 text-emerald-400" />
                              Distance
                            </div>
                            <div className="text-sm font-medium text-foreground">
                              {formatDistance(dist)}
                            </div>
                          </div>
                        )}
                        {maxAlt > 0 && (
                          <div className="bg-background rounded-lg p-3 border border-border">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                              <ArrowUp className="h-3 w-3 text-sky-400" />
                              Max altitude
                            </div>
                            <div className="text-sm font-medium text-foreground">
                              {maxAlt} m
                            </div>
                          </div>
                        )}
                        {flightTime > 0 && (
                          <div className="bg-background rounded-lg p-3 border border-border">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                              <Crosshair className="h-3 w-3 text-orange-400" />
                              Est. time
                            </div>
                            <div className="text-sm font-medium text-foreground">
                              {formatFlightTime(flightTime)}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Map preview */}
                      {mission.waypoints.length > 0 && (
                        <div className="mb-6">
                          <SharedMissionMap
                            waypoints={mission.waypoints}
                            pois={mission.pois}
                            obstacles={mission.obstacles}
                          />
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex flex-wrap gap-3">
                        <Button onClick={handleLoadReadOnly} className="gap-2">
                          <Route className="h-4 w-4" />
                          Open in editor
                        </Button>
                        <Button
                          variant="outline"
                          onClick={handleClone}
                          disabled={cloning}
                          className="gap-2"
                        >
                          <Copy className="h-4 w-4" />
                          {cloning
                            ? "Cloning..."
                            : token
                              ? "Clone to my routes"
                              : "Sign in to clone"}
                        </Button>
                        {mission.waypoints.length >= 2 && (
                          <Button
                            variant="outline"
                            onClick={handleExportKmz}
                            className="gap-2"
                          >
                            <Download className="h-4 w-4" />
                            Export KMZ
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>
      </div>
    </div>
  );
}
