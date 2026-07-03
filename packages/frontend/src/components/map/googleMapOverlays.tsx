import { useEffect, useRef } from "react";
import { AdvancedMarker, useMap } from "@vis.gl/react-google-maps";

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

function buildSvgContent(opts: {
  fillColor: string;
  strokeColor: string;
  scale: number;
  label?: string;
  iconPath?: google.maps.SymbolPath | "arrow" | "circle";
  onRightClick?: (event: google.maps.MapMouseEvent) => void;
}): React.ReactElement {
  const { fillColor, strokeColor, scale, label, iconPath, onRightClick } = opts;
  const onCtx = onRightClick
    ? () => onRightClick({} as google.maps.MapMouseEvent)
    : undefined;
  const size = scale * 2;

  if (iconPath === "arrow") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="-1 -1 2 2"
        style={{ display: "block" }}
        onContextMenu={
          onCtx
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onCtx();
              }
            : undefined
        }
      >
        <polygon
          points="0,-1 0.7,0.7 0,0.3 -0.7,0.7"
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth="0.1"
        />
      </svg>
    );
  }

  // Default: circle with optional label
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      style={{ display: "block" }}
      onContextMenu={
        onCtx
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onCtx();
            }
          : undefined
      }
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
          fontFamily="sans-serif"
        >
          {label}
        </text>
      )}
    </svg>
  );
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
  return (
    <AdvancedMarker
      position={position}
      title={title}
      draggable={draggable}
      clickable={!!onClick}
      zIndex={zIndex}
      anchorPoint={["50%", "50%"]}
      onClick={onClick}
      onDragEnd={
        onDragEnd
          ? (e) => {
              if (e.latLng) {
                onDragEnd({ lat: e.latLng.lat(), lng: e.latLng.lng() });
              }
            }
          : undefined
      }
    >
      {buildSvgContent({
        fillColor,
        strokeColor,
        scale,
        label,
        iconPath,
        onRightClick,
      })}
    </AdvancedMarker>
  );
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
        event.stop();
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
