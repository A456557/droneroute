import { useEffect, useRef } from "react";
import { useMap } from "@vis.gl/react-google-maps";

type LatLngLiteral = google.maps.LatLngLiteral;

interface MarkerOverlayProps {
  position: LatLngLiteral;
  title?: string;
  label?: string;
  fillColor?: string;
  strokeColor?: string;
  scale?: number;
  draggable?: boolean;
  zIndex?: number;
  iconPath?: google.maps.SymbolPath | "arrow" | "circle";
  onClick?: (event: google.maps.MapMouseEvent) => void;
  onRightClick?: (event: google.maps.MapMouseEvent) => void;
  onDragEnd?: (position: LatLngLiteral) => void;
}

function resolveSymbolPath(
  path: google.maps.SymbolPath | "arrow" | "circle" | undefined,
): google.maps.SymbolPath {
  if (path === "arrow") return google.maps.SymbolPath.BACKWARD_CLOSED_ARROW;
  if (path === "circle" || path == null) return google.maps.SymbolPath.CIRCLE;
  return path;
}

export function MarkerOverlay({
  position,
  title,
  label,
  fillColor = "#2563eb",
  strokeColor = "#bfdbfe",
  scale = 10,
  draggable = false,
  zIndex,
  iconPath,
  onClick,
  onRightClick,
  onDragEnd,
}: MarkerOverlayProps) {
  const map = useMap();
  const markerRef = useRef<google.maps.Marker | null>(null);

  useEffect(() => {
    if (!map) return;

    const marker = new google.maps.Marker({
      map,
      position,
      title,
      draggable,
      zIndex,
      label: label
        ? {
            text: label,
            color: "#ffffff",
            fontSize: "11px",
            fontWeight: "700",
          }
        : undefined,
      icon: {
        path: resolveSymbolPath(iconPath),
        fillColor,
        fillOpacity: 1,
        strokeColor,
        strokeOpacity: 1,
        strokeWeight: 2,
        scale,
      },
    });

    markerRef.current = marker;
    return () => {
      marker.setMap(null);
      markerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    marker.setPosition(position);
    marker.setTitle(title ?? "");
    marker.setDraggable(draggable);
    marker.setZIndex(zIndex ?? undefined);
    marker.setLabel(
      label
        ? {
            text: label,
            color: "#ffffff",
            fontSize: "11px",
            fontWeight: "700",
          }
        : null,
    );
    marker.setIcon({
      path: resolveSymbolPath(iconPath),
      fillColor,
      fillOpacity: 1,
      strokeColor,
      strokeOpacity: 1,
      strokeWeight: 2,
      scale,
    });
  }, [
    position,
    title,
    label,
    fillColor,
    strokeColor,
    scale,
    draggable,
    zIndex,
    iconPath,
  ]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    const listeners: google.maps.MapsEventListener[] = [];
    if (onClick) listeners.push(marker.addListener("click", onClick));
    if (onRightClick)
      listeners.push(marker.addListener("rightclick", onRightClick));
    if (onDragEnd) {
      listeners.push(
        marker.addListener("dragend", () => {
          const point = marker.getPosition();
          if (!point) return;
          onDragEnd({ lat: point.lat(), lng: point.lng() });
        }),
      );
    }

    return () => {
      for (const listener of listeners) listener.remove();
    };
  }, [onClick, onRightClick, onDragEnd]);

  return null;
}

interface PolylineOverlayProps {
  path: LatLngLiteral[];
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWeight?: number;
  geodesic?: boolean;
  clickable?: boolean;
  icons?: google.maps.IconSequence[];
  zIndex?: number;
  onClick?: (position: LatLngLiteral) => void;
}

export function PolylineOverlay({
  path,
  strokeColor = "#2563eb",
  strokeOpacity = 1,
  strokeWeight = 3,
  geodesic = true,
  clickable = false,
  icons,
  zIndex,
  onClick,
}: PolylineOverlayProps) {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map) return;
    const polyline = new google.maps.Polyline({
      map,
      path,
      strokeColor,
      strokeOpacity,
      strokeWeight,
      geodesic,
      clickable,
      icons,
      zIndex,
    });
    polylineRef.current = polyline;
    return () => {
      polyline.setMap(null);
      polylineRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const polyline = polylineRef.current;
    if (!polyline) return;
    polyline.setPath(path);
    polyline.setOptions({
      strokeColor,
      strokeOpacity,
      strokeWeight,
      geodesic,
      clickable,
      icons,
      zIndex,
    });
  }, [
    path,
    strokeColor,
    strokeOpacity,
    strokeWeight,
    geodesic,
    clickable,
    icons,
    zIndex,
  ]);

  useEffect(() => {
    const polyline = polylineRef.current;
    if (!polyline || !onClick) return;
    const listener = polyline.addListener(
      "click",
      (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return;
        onClick({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      },
    );
    return () => listener.remove();
  }, [onClick]);

  return null;
}

interface PolygonOverlayProps {
  path: LatLngLiteral[];
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWeight?: number;
  fillColor?: string;
  fillOpacity?: number;
  clickable?: boolean;
  geodesic?: boolean;
  zIndex?: number;
  onClick?: (position: LatLngLiteral) => void;
}

export function PolygonOverlay({
  path,
  strokeColor = "#ef4444",
  strokeOpacity = 0.85,
  strokeWeight = 2,
  fillColor = "#ef4444",
  fillOpacity = 0.15,
  clickable = false,
  geodesic = true,
  zIndex,
  onClick,
}: PolygonOverlayProps) {
  const map = useMap();
  const polygonRef = useRef<google.maps.Polygon | null>(null);

  useEffect(() => {
    if (!map) return;
    const polygon = new google.maps.Polygon({
      map,
      paths: path,
      strokeColor,
      strokeOpacity,
      strokeWeight,
      fillColor,
      fillOpacity,
      clickable,
      geodesic,
      zIndex,
    });
    polygonRef.current = polygon;
    return () => {
      polygon.setMap(null);
      polygonRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const polygon = polygonRef.current;
    if (!polygon) return;
    polygon.setPath(path);
    polygon.setOptions({
      strokeColor,
      strokeOpacity,
      strokeWeight,
      fillColor,
      fillOpacity,
      clickable,
      geodesic,
      zIndex,
    });
  }, [
    path,
    strokeColor,
    strokeOpacity,
    strokeWeight,
    fillColor,
    fillOpacity,
    clickable,
    geodesic,
    zIndex,
  ]);

  useEffect(() => {
    const polygon = polygonRef.current;
    if (!polygon || !onClick) return;
    const listener = polygon.addListener(
      "click",
      (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return;
        onClick({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      },
    );
    return () => listener.remove();
  }, [onClick]);

  return null;
}

interface InfoWindowOverlayProps {
  position: LatLngLiteral;
  content: string;
  onClose?: () => void;
}

export function InfoWindowOverlay({
  position,
  content,
  onClose,
}: InfoWindowOverlayProps) {
  const map = useMap();
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);

  useEffect(() => {
    if (!map) return;
    const infoWindow = new google.maps.InfoWindow({ content, position });
    infoWindow.open({ map });
    infoWindowRef.current = infoWindow;

    const listener = infoWindow.addListener("closeclick", () => {
      onClose?.();
    });

    return () => {
      listener.remove();
      infoWindow.close();
      infoWindowRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const infoWindow = infoWindowRef.current;
    if (!infoWindow) return;
    infoWindow.setContent(content);
    infoWindow.setPosition(position);
  }, [content, position]);

  return null;
}
