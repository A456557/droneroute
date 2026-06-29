import { useRef, useEffect } from "react";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, X, MapPin } from "lucide-react";
import { usePreferencesStore } from "@/store/preferencesStore";
import {
  heightLabel,
  speedLabel,
  distanceLabel,
  toDisplayHeight,
  fromDisplayHeight,
  toDisplaySpeed,
  fromDisplaySpeed,
  toDisplayDistance,
  fromDisplayDistance,
  speedRange,
} from "@/lib/units";
import type {
  FacadeCopilotObjective,
  FacadeCopilotRecommendation,
} from "@/lib/api";
import type {
  TemplateType,
  OrbitParams,
  GridParams,
  FacadeParams,
  PencilParams,
} from "@/lib/templates";
import type { PointOfInterest } from "@droneroute/shared";

interface TemplateConfigPanelProps {
  type: TemplateType;
  orbitParams?: OrbitParams | null;
  gridParams?: GridParams | null;
  facadeParams?: FacadeParams | null;
  pencilParams?: PencilParams | null;
  onOrbitChange?: (params: OrbitParams) => void;
  onGridChange?: (params: GridParams) => void;
  onFacadeChange?: (params: FacadeParams) => void;
  onPencilChange?: (params: PencilParams) => void;
  onApply: () => void;
  onCancel: () => void;
  onFacadeAssist?: () => void;
  onFacadeObjectiveChange?: (objective: FacadeCopilotObjective) => void;
  onFacadeSegmentSelect?: (segmentId: string) => void;
  onFacadeVariantSelect?: (variantId: string) => void;
  facadeObjective?: FacadeCopilotObjective;
  facadeAssistBusy?: boolean;
  facadeAssistMessage?: string | null;
  facadeRecommendationBusy?: boolean;
  facadeRecommendation?: FacadeCopilotRecommendation | null;
  facadeSegments?: Array<{
    id: string;
    label: string;
    detail: string;
    selected: boolean;
  }>;
  facadeVariants?: Array<{
    id: string;
    label: string;
    detail: string;
    selected: boolean;
  }>;
  waypointCount: number;
  pois?: PointOfInterest[];
}

export function TemplateConfigPanel({
  type,
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
  onFacadeSegmentSelect,
  onFacadeVariantSelect,
  facadeObjective,
  facadeAssistBusy,
  facadeAssistMessage,
  facadeRecommendationBusy,
  facadeRecommendation,
  facadeSegments,
  facadeVariants,
  waypointCount,
  pois,
}: TemplateConfigPanelProps) {
  const unitSystem = usePreferencesStore((s) => s.preferences.unitSystem);
  const title =
    type === "orbit"
      ? "Orbit"
      : type === "grid"
        ? "Grid survey"
        : type === "facade"
          ? "Facade scan"
          : "Pencil path";
  const description =
    type === "orbit"
      ? "Circular flight path around a center point. Adjust the radius, number of points, and enable POI to keep the camera focused on the center."
      : type === "grid"
        ? "Lawn-mower zigzag pattern for systematic area coverage. Control line spacing for overlap and rotation to align with the terrain."
        : type === "facade"
          ? "Vertical scanning pattern along a wall or building face. Set the standoff distance, altitude range, and grid density for full coverage."
          : "Freehand flight path drawn on the map. Adjust the number of waypoints to control how closely the path is followed.";
  const facadeObjectives: Array<{
    value: FacadeCopilotObjective;
    label: string;
  }> = [
    { value: "balanced", label: "Balanced coverage" },
    { value: "inspection", label: "Inspection detail" },
    { value: "reconstruction", label: "3D reconstruction" },
    { value: "speed", label: "Fast capture" },
  ];

  // Stop all pointer/keyboard/wheel events from reaching Leaflet (native DOM level)
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const events = [
      "mousedown",
      "mouseup",
      "dblclick",
      "wheel",
      "keydown",
      "keyup",
      "pointerdown",
      "pointerup",
      "touchstart",
      "touchend",
    ];
    for (const evt of events) el.addEventListener(evt, stop);
    return () => {
      for (const evt of events) el.removeEventListener(evt, stop);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-card/95 backdrop-blur-sm border border-border rounded-lg shadow-2xl p-3 min-w-[320px] max-w-[420px]"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
            {title}
          </span>
          <Badge variant="secondary" className="text-[10px] gap-1">
            <MapPin className="h-3 w-3" />
            {waypointCount} waypoints
          </Badge>
        </div>
        <button
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground mb-3">{description}</p>

      {/* Orbit params */}
      {type === "orbit" && orbitParams && onOrbitChange && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <Label className="text-[10px]">
              Radius ({distanceLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayDistance(orbitParams.radiusM, unitSystem)}
              onChange={(v) =>
                onOrbitChange({
                  ...orbitParams,
                  radiusM: fromDisplayDistance(v, unitSystem),
                })
              }
              min={5}
              step={5}
              fallback={5}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">
              Altitude ({heightLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayHeight(orbitParams.altitude, unitSystem)}
              onChange={(v) =>
                onOrbitChange({
                  ...orbitParams,
                  altitude: fromDisplayHeight(v, unitSystem),
                })
              }
              min={5}
              step={5}
              fallback={30}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">Points</Label>
            <NumericInput
              value={orbitParams.numPoints}
              onChange={(v) => onOrbitChange({ ...orbitParams, numPoints: v })}
              min={3}
              max={72}
              fallback={12}
              integer
              className="h-7 text-xs"
            />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={orbitParams.clockwise}
                onChange={(e) =>
                  onOrbitChange({ ...orbitParams, clockwise: e.target.checked })
                }
                className="rounded"
              />
              Clockwise
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={orbitParams.createPoi}
                onChange={(e) =>
                  onOrbitChange({ ...orbitParams, createPoi: e.target.checked })
                }
                className="rounded"
              />
              Center POI
            </label>
          </div>
        </div>
      )}

      {/* Grid params */}
      {type === "grid" && gridParams && onGridChange && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <Label className="text-[10px]">
              Altitude ({heightLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayHeight(gridParams.altitude, unitSystem)}
              onChange={(v) =>
                onGridChange({
                  ...gridParams,
                  altitude: fromDisplayHeight(v, unitSystem),
                })
              }
              min={5}
              step={5}
              fallback={80}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">
              Line spacing ({distanceLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayDistance(gridParams.spacingM, unitSystem)}
              onChange={(v) =>
                onGridChange({
                  ...gridParams,
                  spacingM: fromDisplayDistance(v, unitSystem),
                })
              }
              min={3}
              step={5}
              fallback={30}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">Rotation (°)</Label>
            <NumericInput
              value={gridParams.rotationDeg}
              onChange={(v) => onGridChange({ ...gridParams, rotationDeg: v })}
              min={-180}
              max={180}
              step={5}
              fallback={0}
              className="h-7 text-xs"
            />
          </div>
          <div className="flex items-end gap-2 pb-1">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={gridParams.addPhotos}
                onChange={(e) =>
                  onGridChange({ ...gridParams, addPhotos: e.target.checked })
                }
                className="rounded"
              />
              Photos
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={gridParams.reverse}
                onChange={(e) =>
                  onGridChange({ ...gridParams, reverse: e.target.checked })
                }
                className="rounded"
              />
              Reverse
            </label>
          </div>
        </div>
      )}

      {/* Facade params */}
      {type === "facade" && facadeParams && onFacadeChange && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <Label className="text-[10px]">
              Distance from wall ({distanceLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayDistance(facadeParams.distanceM, unitSystem)}
              onChange={(v) =>
                onFacadeChange({
                  ...facadeParams,
                  distanceM: fromDisplayDistance(v, unitSystem),
                })
              }
              min={3}
              step={5}
              fallback={20}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">
              Min altitude ({heightLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayHeight(facadeParams.minAltitude, unitSystem)}
              onChange={(v) => {
                const metricV = fromDisplayHeight(v, unitSystem);
                onFacadeChange({
                  ...facadeParams,
                  minAltitude: metricV,
                  maxAltitude: Math.max(metricV + 5, facadeParams.maxAltitude),
                });
              }}
              min={2}
              step={5}
              fallback={10}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">
              Max altitude ({heightLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayHeight(facadeParams.maxAltitude, unitSystem)}
              onChange={(v) =>
                onFacadeChange({
                  ...facadeParams,
                  maxAltitude: Math.max(
                    facadeParams.minAltitude + 5,
                    fromDisplayHeight(v, unitSystem),
                  ),
                })
              }
              min={toDisplayHeight(facadeParams.minAltitude + 5, unitSystem)}
              step={5}
              fallback={30}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">Rows</Label>
            <NumericInput
              value={facadeParams.numRows}
              onChange={(v) => onFacadeChange({ ...facadeParams, numRows: v })}
              min={1}
              max={20}
              fallback={4}
              integer
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">Columns</Label>
            <NumericInput
              value={facadeParams.numColumns}
              onChange={(v) =>
                onFacadeChange({ ...facadeParams, numColumns: v })
              }
              min={2}
              max={30}
              fallback={8}
              integer
              className="h-7 text-xs"
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={facadeParams.addPhotos}
                onChange={(e) =>
                  onFacadeChange({
                    ...facadeParams,
                    addPhotos: e.target.checked,
                  })
                }
                className="rounded"
              />
              Photos
            </label>
          </div>
          {onFacadeAssist && (
            <div className="col-span-2 space-y-2 rounded-md border border-border/80 bg-background/70 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium">Building assist</p>
                  <p className="text-[10px] text-muted-foreground">
                    Detect the closest footprint and auto-fit the facade scan.
                  </p>
                  {onFacadeObjectiveChange && facadeObjective && (
                    <div className="mt-2 max-w-[220px] space-y-1">
                      <Label className="text-[10px] text-muted-foreground">
                        Mission goal
                      </Label>
                      <Select
                        value={facadeObjective}
                        onValueChange={(value) =>
                          onFacadeObjectiveChange(
                            value as FacadeCopilotObjective,
                          )
                        }
                      >
                        <SelectTrigger className="h-7 text-[11px]">
                          <SelectValue placeholder="Choose a goal" />
                        </SelectTrigger>
                        <SelectContent>
                          {facadeObjectives.map((objective) => (
                            <SelectItem
                              key={objective.value}
                              value={objective.value}
                            >
                              {objective.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onFacadeAssist}
                  disabled={facadeAssistBusy}
                  className="h-7 text-[11px]"
                >
                  {facadeAssistBusy ? "Analyzing..." : "Auto-fit"}
                </Button>
              </div>
              {facadeAssistMessage && (
                <p className="text-[10px] text-muted-foreground">
                  {facadeAssistMessage}
                </p>
              )}
              {(facadeRecommendationBusy || facadeRecommendation) && (
                <div className="space-y-1 rounded-md border border-cyan-500/30 bg-cyan-500/5 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-medium text-foreground">
                      Copilot recommendation
                    </p>
                    {facadeRecommendation && (
                      <span className="text-[10px] text-cyan-300">
                        {Math.round(facadeRecommendation.confidence * 100)}%
                      </span>
                    )}
                  </div>
                  {facadeRecommendationBusy && !facadeRecommendation ? (
                    <p className="text-[10px] text-muted-foreground">
                      Building a facade recommendation...
                    </p>
                  ) : null}
                  {facadeRecommendation && (
                    <>
                      <p className="text-[10px] text-foreground">
                        {facadeRecommendation.summary}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Goal: {facadeRecommendation.objectiveLabel}. Recommended
                        variant: {facadeRecommendation.recommendedVariantLabel}.
                        {facadeRecommendation.currentVariantMatchesRecommendation ===
                        true
                          ? " Current selection matches."
                          : facadeRecommendation.currentVariantMatchesRecommendation ===
                              false
                            ? " Current selection differs."
                            : ""}
                      </p>
                      {facadeRecommendation.rationale
                        .slice(0, 2)
                        .map((reason) => (
                          <p
                            key={reason}
                            className="text-[10px] text-muted-foreground"
                          >
                            • {reason}
                          </p>
                        ))}
                      {facadeRecommendation.risks.slice(0, 1).map((risk) => (
                        <p key={risk} className="text-[10px] text-amber-200/90">
                          Risk: {risk}
                        </p>
                      ))}
                    </>
                  )}
                </div>
              )}
              {facadeSegments &&
                facadeSegments.length > 0 &&
                onFacadeSegmentSelect && (
                  <div className="space-y-1">
                    <p className="text-[10px] font-medium text-foreground">
                      Detected facades
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {facadeSegments.map((segment) => (
                        <button
                          key={segment.id}
                          type="button"
                          onClick={() => onFacadeSegmentSelect(segment.id)}
                          className={`rounded-md border px-2 py-1 text-left text-[10px] ${segment.selected ? "border-primary bg-primary/15 text-foreground" : "border-border bg-background/60 text-muted-foreground"}`}
                        >
                          <span className="block font-medium">
                            {segment.label}
                          </span>
                          <span className="block">{segment.detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              {facadeVariants &&
                facadeVariants.length > 0 &&
                onFacadeVariantSelect && (
                  <div className="space-y-1">
                    <p className="text-[10px] font-medium text-foreground">
                      Scan variants
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {facadeVariants.map((variant) => (
                        <button
                          key={variant.id}
                          type="button"
                          onClick={() => onFacadeVariantSelect(variant.id)}
                          className={`rounded-md border px-2 py-1 text-left text-[10px] ${variant.selected ? "border-primary bg-primary/15 text-foreground" : "border-border bg-background/60 text-muted-foreground"}`}
                        >
                          <span className="block font-medium">
                            {variant.label}
                          </span>
                          <span className="block">{variant.detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      {/* Pencil params */}
      {type === "pencil" && pencilParams && onPencilChange && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <Label className="text-[10px]">Waypoints</Label>
            <NumericInput
              value={pencilParams.numPoints}
              onChange={(v) =>
                onPencilChange({ ...pencilParams, numPoints: v })
              }
              min={2}
              max={200}
              fallback={10}
              integer
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">
              Altitude ({heightLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplayHeight(pencilParams.altitude, unitSystem)}
              onChange={(v) =>
                onPencilChange({
                  ...pencilParams,
                  altitude: fromDisplayHeight(v, unitSystem),
                })
              }
              min={5}
              step={5}
              fallback={30}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">
              Speed ({speedLabel(unitSystem)})
            </Label>
            <NumericInput
              value={toDisplaySpeed(pencilParams.speed, unitSystem)}
              onChange={(v) =>
                onPencilChange({
                  ...pencilParams,
                  speed: fromDisplaySpeed(v, unitSystem),
                })
              }
              min={speedRange(unitSystem).min}
              max={speedRange(unitSystem).max}
              step={speedRange(unitSystem).step}
              fallback={7}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px]">Gimbal pitch (°)</Label>
            <NumericInput
              value={pencilParams.gimbalPitchAngle}
              onChange={(v) =>
                onPencilChange({ ...pencilParams, gimbalPitchAngle: v })
              }
              min={-90}
              max={45}
              step={5}
              fallback={-45}
              className="h-7 text-xs"
            />
          </div>
          <div className="flex items-end pb-1 gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={pencilParams.reverse}
                onChange={(e) =>
                  onPencilChange({ ...pencilParams, reverse: e.target.checked })
                }
                className="rounded"
              />
              Reverse
            </label>
          </div>
          {pois && pois.length > 0 && (
            <div>
              <Label className="text-[10px]">Face POI</Label>
              <Select
                value={pencilParams.poiId || "none"}
                onValueChange={(v) =>
                  onPencilChange({
                    ...pencilParams,
                    poiId: v === "none" ? undefined : v,
                  })
                }
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (follow path)</SelectItem>
                  {pois.map((poi) => (
                    <SelectItem key={poi.id} value={poi.id}>
                      {poi.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={onApply}
          className="flex-1 h-7 text-xs bg-purple-600 hover:bg-purple-700 text-white"
        >
          <Check className="h-3 w-3 mr-1" />
          Apply
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="h-7 text-xs"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
