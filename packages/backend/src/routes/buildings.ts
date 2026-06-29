import { Router } from "express";

type LatLng = { lat: number; lng: number };

interface OverpassWay {
  id: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

interface DetectedBuildingResponse {
  id: string;
  footprint: LatLng[];
  centroid: LatLng;
  confidence: number;
  estimatedHeightM: number | null;
  source: string;
  distanceToQueryM: number;
}

type FacadeCopilotObjective =
  | "balanced"
  | "inspection"
  | "reconstruction"
  | "speed";

interface FacadeRecommendationVariantInput {
  id: string;
  label: string;
  score: number;
  detail: string;
  params: {
    distanceM: number;
    minAltitude: number;
    maxAltitude: number;
    numRows: number;
    numColumns: number;
  };
}

interface FacadeRecommendationRequest {
  objective?: FacadeCopilotObjective;
  currentVariantId?: string | null;
  building?: Pick<
    DetectedBuildingResponse,
    "id" | "estimatedHeightM" | "source" | "distanceToQueryM"
  >;
  selectedSegment?: {
    id: string;
    label: string;
    lengthM: number;
    distanceToHintM: number;
    angleDeltaDeg: number;
    score: number;
  };
  variants?: FacadeRecommendationVariantInput[];
}

interface FacadeRecommendationResponse {
  objective: FacadeCopilotObjective;
  objectiveLabel: string;
  recommendedVariantId: string;
  recommendedVariantLabel: string;
  summary: string;
  rationale: string[];
  risks: string[];
  nextStep: string;
  confidence: number;
  currentVariantId: string | null;
  currentVariantMatchesRecommendation: boolean | null;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function polygonCentroid(points: LatLng[]): LatLng {
  if (points.length === 0) return { lat: 0, lng: 0 };
  const uniquePoints =
    points.length > 1 &&
    points[0].lat === points[points.length - 1].lat &&
    points[0].lng === points[points.length - 1].lng
      ? points.slice(0, -1)
      : points;
  const total = uniquePoints.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 },
  );
  return {
    lat: total.lat / uniquePoints.length,
    lng: total.lng / uniquePoints.length,
  };
}

function parseHeight(tags: Record<string, string> | undefined): number | null {
  if (!tags) return null;
  if (tags.height) {
    const parsed = Number.parseFloat(tags.height.replace("m", "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  if (tags["building:levels"]) {
    const levels = Number.parseFloat(tags["building:levels"]);
    if (Number.isFinite(levels)) return levels * 3;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeObjective(value: unknown): FacadeCopilotObjective {
  switch (value) {
    case "inspection":
    case "reconstruction":
    case "speed":
    case "balanced":
      return value;
    default:
      return "balanced";
  }
}

function objectiveLabel(objective: FacadeCopilotObjective): string {
  switch (objective) {
    case "inspection":
      return "Inspection detail";
    case "reconstruction":
      return "3D reconstruction";
    case "speed":
      return "Fast capture";
    default:
      return "Balanced coverage";
  }
}

function scoreRecommendationVariant(args: {
  variant: FacadeRecommendationVariantInput;
  building: NonNullable<FacadeRecommendationRequest["building"]>;
  selectedSegment: NonNullable<FacadeRecommendationRequest["selectedSegment"]>;
  objective: FacadeCopilotObjective;
}): number {
  const { variant, building, selectedSegment, objective } = args;
  const estimatedHeightM = Math.max(
    12,
    building.estimatedHeightM ?? variant.params.maxAltitude,
  );
  const totalShots = Math.max(
    1,
    variant.params.numRows * variant.params.numColumns,
  );
  const idealDistanceM = clamp(estimatedHeightM * 0.55, 10, 24);
  const safety =
    1 - Math.min(1, Math.abs(variant.params.distanceM - idealDistanceM) / 20);
  const density = clamp((totalShots - 12) / 24, 0, 1);
  const detail = clamp(
    (1 - (variant.params.distanceM - 8) / 27) * 0.6 + density * 0.4,
    0,
    1,
  );
  const efficiency = clamp(18 / Math.max(12, totalShots), 0.35, 1);
  const verticalTarget = Math.max(3.5, variant.params.distanceM * 0.42);
  const horizontalTarget = Math.max(3.5, variant.params.distanceM * 0.58);
  const verticalStep =
    estimatedHeightM / Math.max(1, variant.params.numRows - 1);
  const horizontalStep =
    selectedSegment.lengthM / Math.max(1, variant.params.numColumns - 1);
  const coverage =
    (Math.min(1, verticalTarget / verticalStep) +
      Math.min(1, horizontalTarget / horizontalStep)) /
    2;
  const baseScore = clamp(variant.score, 0, 1);

  switch (objective) {
    case "inspection":
      return baseScore * 0.4 + detail * 0.25 + coverage * 0.2 + safety * 0.15;
    case "reconstruction":
      return baseScore * 0.35 + coverage * 0.35 + detail * 0.15 + safety * 0.15;
    case "speed":
      return (
        baseScore * 0.35 + efficiency * 0.4 + safety * 0.15 + coverage * 0.1
      );
    default:
      return (
        baseScore * 0.5 + coverage * 0.2 + efficiency * 0.15 + safety * 0.15
      );
  }
}

function buildRecommendationRationale(args: {
  variant: FacadeRecommendationVariantInput;
  building: NonNullable<FacadeRecommendationRequest["building"]>;
  selectedSegment: NonNullable<FacadeRecommendationRequest["selectedSegment"]>;
  objective: FacadeCopilotObjective;
}): string[] {
  const { variant, building, selectedSegment, objective } = args;
  const estimatedHeightM = Math.round(
    Math.max(12, building.estimatedHeightM ?? variant.params.maxAltitude),
  );
  const totalShots = variant.params.numRows * variant.params.numColumns;
  const reasons = [
    `${variant.label} keeps ${variant.params.numColumns} columns by ${variant.params.numRows} rows over a ${Math.round(selectedSegment.lengthM)}m facade.`,
    `The ${Math.round(variant.params.distanceM)}m standoff stays close to the framing band expected for a ${estimatedHeightM}m building.`,
  ];

  if (objective === "reconstruction") {
    reasons.push(
      `Its capture density is better suited to full-height reconstruction than a lighter pass count of ${totalShots} photos.`,
    );
  } else if (objective === "speed") {
    reasons.push(
      `It limits the mission load to about ${totalShots} capture points while preserving usable facade coverage.`,
    );
  } else if (objective === "inspection") {
    reasons.push(
      `The denser framing improves readability around edges and openings during manual inspection.`,
    );
  } else {
    reasons.push(
      `It balances coverage quality and mission size, which is usually the safest default before export.`,
    );
  }

  return reasons;
}

function buildRecommendationRisks(args: {
  variant: FacadeRecommendationVariantInput;
  building: NonNullable<FacadeRecommendationRequest["building"]>;
  selectedSegment: NonNullable<FacadeRecommendationRequest["selectedSegment"]>;
}): string[] {
  const { variant, building, selectedSegment } = args;
  const risks: string[] = [];
  const totalShots = variant.params.numRows * variant.params.numColumns;

  if (building.estimatedHeightM == null) {
    risks.push(
      "Building height is estimated from defaults, so vertical coverage should be checked visually.",
    );
  }
  if (selectedSegment.distanceToHintM > 18) {
    risks.push(
      "The chosen facade is offset from the original sketch, so confirm the face in 2D or 3D before export.",
    );
  }
  if (variant.params.distanceM < 10) {
    risks.push(
      "Short standoff can increase obstacle sensitivity near balconies, trees, or cables.",
    );
  }
  if (totalShots > 40) {
    risks.push(
      "High capture density may increase mission time and battery pressure.",
    );
  }

  if (risks.length === 0) {
    risks.push(
      "Obstacle clearance still needs a manual check because upstream building data does not include local clutter.",
    );
  }

  return risks;
}

async function fetchNearbyBuildings(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<DetectedBuildingResponse[]> {
  const query = `
[out:json][timeout:12];
(
  way["building"](around:${Math.round(radiusM)},${lat},${lng});
  way["building:part"](around:${Math.round(radiusM)},${lat},${lng});
);
out tags geom;
`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query,
  });

  if (!response.ok) {
    throw new Error(`Overpass request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { elements?: OverpassWay[] };
  const elements = Array.isArray(payload.elements) ? payload.elements : [];

  return elements
    .map((element): DetectedBuildingResponse | null => {
      const geometry = Array.isArray(element.geometry)
        ? element.geometry
            .map((point) => ({ lat: point.lat, lng: point.lon }))
            .filter(
              (point) =>
                Number.isFinite(point.lat) && Number.isFinite(point.lng),
            )
        : [];

      if (geometry.length < 4) return null;

      const footprint =
        geometry[0].lat === geometry[geometry.length - 1].lat &&
        geometry[0].lng === geometry[geometry.length - 1].lng
          ? geometry
          : [...geometry, geometry[0]];

      const centroid = polygonCentroid(footprint);

      return {
        id: `osm-${element.id}`,
        footprint,
        centroid,
        confidence: element.tags?.building ? 0.95 : 0.8,
        estimatedHeightM: parseHeight(element.tags),
        source: element.tags?.building ? "osm" : "osm-building-part",
        distanceToQueryM: haversineMeters({ lat, lng }, centroid),
      };
    })
    .filter(
      (building): building is DetectedBuildingResponse => building !== null,
    )
    .sort((a, b) => a.distanceToQueryM - b.distanceToQueryM);
}

export const buildingRoutes = Router();

buildingRoutes.post("/detect", async (req, res) => {
  const { lat, lng, radiusM } = req.body ?? {};

  if (![lat, lng].every((value) => Number.isFinite(value))) {
    res.status(400).json({ error: "lat and lng must be valid numbers" });
    return;
  }

  const searchRadiusM = Number.isFinite(radiusM)
    ? Math.min(Math.max(Number(radiusM), 20), 250)
    : 80;

  try {
    const buildings = await fetchNearbyBuildings(
      Number(lat),
      Number(lng),
      searchRadiusM,
    );

    if (buildings.length === 0) {
      res
        .status(404)
        .json({ error: "No building found near the selected facade" });
      return;
    }

    res.json({
      building: buildings[0],
      candidates: buildings.slice(0, 5),
    });
  } catch (error) {
    console.error("Building detection error:", error);
    res.status(502).json({
      error: "Failed to detect building footprint from upstream data",
    });
  }
});

buildingRoutes.post("/recommend-facade-scan", (req, res) => {
  const {
    objective: rawObjective,
    currentVariantId,
    building,
    selectedSegment,
    variants,
  } = (req.body ?? {}) as FacadeRecommendationRequest;

  if (
    !building ||
    !selectedSegment ||
    !Array.isArray(variants) ||
    variants.length === 0
  ) {
    res.status(400).json({
      error: "building, selectedSegment, and at least one variant are required",
    });
    return;
  }

  const validVariants = variants.filter(
    (variant) =>
      typeof variant?.id === "string" &&
      typeof variant?.label === "string" &&
      Number.isFinite(variant?.score) &&
      Number.isFinite(variant?.params?.distanceM) &&
      Number.isFinite(variant?.params?.minAltitude) &&
      Number.isFinite(variant?.params?.maxAltitude) &&
      Number.isFinite(variant?.params?.numRows) &&
      Number.isFinite(variant?.params?.numColumns),
  );

  if (
    typeof building.id !== "string" ||
    !Number.isFinite(building.distanceToQueryM) ||
    typeof selectedSegment.id !== "string" ||
    !Number.isFinite(selectedSegment.lengthM) ||
    validVariants.length === 0
  ) {
    res.status(400).json({ error: "Invalid recommendation payload" });
    return;
  }

  const objective = normalizeObjective(rawObjective);
  const ranked = validVariants
    .map((variant) => ({
      variant,
      score: scoreRecommendationVariant({
        variant,
        building,
        selectedSegment,
        objective,
      }),
    }))
    .sort((a, b) => b.score - a.score);

  const recommended = ranked[0];
  const runnerUp = ranked[1];
  const confidence = clamp(
    0.55 +
      (recommended.score - (runnerUp?.score ?? recommended.score - 0.08)) *
        0.9 +
      clamp(recommended.variant.score, 0, 1) * 0.12,
    0.45,
    0.96,
  );

  const response: FacadeRecommendationResponse = {
    objective,
    objectiveLabel: objectiveLabel(objective),
    recommendedVariantId: recommended.variant.id,
    recommendedVariantLabel: recommended.variant.label,
    summary: `${recommended.variant.label} is the best fit for this facade because it keeps useful coverage on ${Math.round(selectedSegment.lengthM)}m of wall without overloading the mission.`,
    rationale: buildRecommendationRationale({
      variant: recommended.variant,
      building,
      selectedSegment,
      objective,
    }),
    risks: buildRecommendationRisks({
      variant: recommended.variant,
      building,
      selectedSegment,
    }),
    nextStep:
      "Review the facade in 2D or Buildings 3D, then validate obstacle clearance before exporting the mission.",
    confidence,
    currentVariantId:
      typeof currentVariantId === "string" ? currentVariantId : null,
    currentVariantMatchesRecommendation:
      typeof currentVariantId === "string"
        ? currentVariantId === recommended.variant.id
        : null,
  };

  res.json(response);
});
