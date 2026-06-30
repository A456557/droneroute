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
  heightSource: "osm-height" | "osm-levels" | null;
  levels: number | null;
  roofShape: string | null;
  roofDirectionDeg: number | null;
  roofHeightM: number | null;
  source: string;
  distanceToQueryM: number;
}

interface RnbApiBuilding {
  rnb_id: string;
  status?: string;
  point?: {
    type?: string;
    coordinates?: number[];
  };
  shape?: {
    type?: string;
    coordinates?: unknown;
  };
  ext_ids?: Array<{
    id?: string;
    source?: string;
    created_at?: string;
    source_version?: string;
  }>;
  is_active?: boolean;
  addresses?: unknown[];
}

interface RnbBuildingResponse {
  rnbId: string;
  status: string | null;
  point: LatLng;
  footprint: LatLng[];
  extIds: Array<{
    id: string;
    source: string;
    createdAt: string | null;
    sourceVersion: string | null;
  }>;
  bdTopoId: string | null;
  isActive: boolean;
  addressCount: number;
}

interface BdTopoFeatureResponse {
  type?: string;
  features?: Array<{
    geometry?: {
      type?: string;
      coordinates?: unknown;
    };
    properties?: Record<string, unknown>;
  }>;
}

interface BdTopoMatchedBuildingResponse {
  cleabs: string;
  nature: string | null;
  usage1: string | null;
  usage2: string | null;
  heightM: number | null;
  floorCount: number | null;
  status: string | null;
  origin: string | null;
  sourceMethodPlanimetric: string | null;
  sourceMethodAltimetric: string | null;
  rnbIds: string | null;
  centroid: LatLng;
  footprint: LatLng[];
}

interface BdnbBuildingEnrichmentResponse {
  batimentGroupeId: string | null;
  constructionYear: number | null;
  wallMaterial: string | null;
  clayRisk: string | null;
  heatingType: string | null;
  dpeClass: string | null;
  gesClass: string | null;
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

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace("m", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUnknownNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseUnknownString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractFootprintFromGeoJsonShape(shape: unknown): LatLng[] {
  if (!shape || typeof shape !== "object") return [];

  const geometry = shape as { type?: string; coordinates?: unknown };
  const type = geometry.type;
  const coordinates = geometry.coordinates;

  const toPath = (ring: unknown): LatLng[] =>
    Array.isArray(ring)
      ? ring
          .map((point) => {
            if (!Array.isArray(point) || point.length < 2) return null;
            const lng = parseUnknownNumber(point[0]);
            const lat = parseUnknownNumber(point[1]);
            return lat !== null && lng !== null ? { lat, lng } : null;
          })
          .filter((point): point is LatLng => point !== null)
      : [];

  if (
    type === "Polygon" &&
    Array.isArray(coordinates) &&
    coordinates.length > 0
  ) {
    return toPath(coordinates[0]);
  }

  if (
    type === "MultiPolygon" &&
    Array.isArray(coordinates) &&
    coordinates.length > 0 &&
    Array.isArray(coordinates[0]) &&
    coordinates[0].length > 0
  ) {
    return toPath(coordinates[0][0]);
  }

  return [];
}

function normalizeClosedFootprint(path: LatLng[]): LatLng[] {
  if (path.length < 3) return [];

  const first = path[0];
  const last = path[path.length - 1];
  if (first.lat === last.lat && first.lng === last.lng) {
    return path;
  }

  return [...path, first];
}

function escapeCqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function parseHeight(tags: Record<string, string> | undefined): {
  estimatedHeightM: number | null;
  heightSource: "osm-height" | "osm-levels" | null;
  levels: number | null;
  roofHeightM: number | null;
  roofShape: string | null;
  roofDirectionDeg: number | null;
} {
  if (!tags) {
    return {
      estimatedHeightM: null,
      heightSource: null,
      levels: null,
      roofHeightM: null,
      roofShape: null,
      roofDirectionDeg: null,
    };
  }

  const explicitHeight = parseOptionalNumber(tags.height);
  const levels = parseOptionalNumber(tags["building:levels"]);
  const roofHeightM = parseOptionalNumber(tags["roof:height"]);
  const roofDirectionDeg = parseOptionalNumber(tags["roof:direction"]);
  const roofShape = tags["roof:shape"]?.trim().toLowerCase() || null;

  if (explicitHeight != null) {
    return {
      estimatedHeightM: explicitHeight,
      heightSource: "osm-height",
      levels,
      roofHeightM,
      roofShape,
      roofDirectionDeg,
    };
  }

  if (levels != null) {
    return {
      estimatedHeightM: levels * 3,
      heightSource: "osm-levels",
      levels,
      roofHeightM,
      roofShape,
      roofDirectionDeg,
    };
  }

  return {
    estimatedHeightM: null,
    heightSource: null,
    levels,
    roofHeightM,
    roofShape,
    roofDirectionDeg,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRnbBuilding(
  building: RnbApiBuilding,
): RnbBuildingResponse | null {
  if (typeof building.rnb_id !== "string") {
    return null;
  }

  const pointCoordinates = Array.isArray(building.point?.coordinates)
    ? building.point?.coordinates
    : [];
  const lng = parseUnknownNumber(pointCoordinates[0]);
  const lat = parseUnknownNumber(pointCoordinates[1]);
  const footprint = normalizeClosedFootprint(
    extractFootprintFromGeoJsonShape(building.shape),
  );

  if (lat === null || lng === null || footprint.length < 4) {
    return null;
  }

  const extIds = Array.isArray(building.ext_ids)
    ? building.ext_ids
        .map((extId) => {
          const id = typeof extId?.id === "string" ? extId.id : null;
          const source =
            typeof extId?.source === "string" ? extId.source : null;
          if (!id || !source) return null;

          return {
            id,
            source,
            createdAt:
              typeof extId.created_at === "string" ? extId.created_at : null,
            sourceVersion:
              typeof extId.source_version === "string"
                ? extId.source_version
                : null,
          };
        })
        .filter(
          (
            extId,
          ): extId is {
            id: string;
            source: string;
            createdAt: string | null;
            sourceVersion: string | null;
          } => extId !== null,
        )
    : [];

  return {
    rnbId: building.rnb_id,
    status: typeof building.status === "string" ? building.status : null,
    point: { lat, lng },
    footprint,
    extIds,
    bdTopoId:
      extIds.find((extId) => extId.source.toLowerCase() === "bdtopo")?.id ??
      null,
    isActive: building.is_active !== false,
    addressCount: Array.isArray(building.addresses)
      ? building.addresses.length
      : 0,
  };
}

function normalizeBdTopoFeature(
  feature: NonNullable<BdTopoFeatureResponse["features"]>[number] | undefined,
): BdTopoMatchedBuildingResponse | null {
  const properties = feature?.properties ?? {};
  const footprint = normalizeClosedFootprint(
    extractFootprintFromGeoJsonShape(feature?.geometry),
  );

  if (footprint.length < 4) {
    return null;
  }

  return {
    cleabs: typeof properties.cleabs === "string" ? properties.cleabs : "",
    nature: typeof properties.nature === "string" ? properties.nature : null,
    usage1: typeof properties.usage_1 === "string" ? properties.usage_1 : null,
    usage2: typeof properties.usage_2 === "string" ? properties.usage_2 : null,
    heightM: parseUnknownNumber(properties.hauteur),
    floorCount: parseUnknownNumber(properties.nombre_d_etages),
    status:
      typeof properties.etat_de_l_objet === "string"
        ? properties.etat_de_l_objet
        : null,
    origin:
      typeof properties.origine_du_batiment === "string"
        ? properties.origine_du_batiment
        : null,
    sourceMethodPlanimetric:
      typeof properties.methode_d_acquisition_planimetrique === "string"
        ? properties.methode_d_acquisition_planimetrique
        : null,
    sourceMethodAltimetric:
      typeof properties.methode_d_acquisition_altimetrique === "string"
        ? properties.methode_d_acquisition_altimetrique
        : null,
    rnbIds:
      typeof properties.identifiants_rnb === "string"
        ? properties.identifiants_rnb
        : null,
    centroid: polygonCentroid(footprint),
    footprint,
  };
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
      const height = parseHeight(element.tags);
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
        estimatedHeightM: height.estimatedHeightM,
        heightSource: height.heightSource,
        levels: height.levels,
        roofShape: height.roofShape,
        roofDirectionDeg: height.roofDirectionDeg,
        roofHeightM: height.roofHeightM,
        source: element.tags?.building ? "osm" : "osm-building-part",
        distanceToQueryM: haversineMeters({ lat, lng }, centroid),
      };
    })
    .filter(
      (building): building is DetectedBuildingResponse => building !== null,
    )
    .sort((a, b) => a.distanceToQueryM - b.distanceToQueryM);
}

async function fetchRnbBuildingsForBbox(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<RnbBuildingResponse[]> {
  const url = new URL("https://rnb-api.beta.gouv.fr/api/alpha/buildings");
  url.searchParams.set("bbox", `${west},${south},${east},${north}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`RNB request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { results?: RnbApiBuilding[] };
  const results = Array.isArray(payload.results) ? payload.results : [];

  return results
    .map(normalizeRnbBuilding)
    .filter((building): building is RnbBuildingResponse => building !== null);
}

async function fetchBdTopoBuildingMatch(args: {
  rnbId?: string;
  bdTopoId?: string;
}): Promise<BdTopoMatchedBuildingResponse | null> {
  const filter = args.bdTopoId
    ? `cleabs='${escapeCqlLiteral(args.bdTopoId)}'`
    : args.rnbId
      ? `identifiants_rnb LIKE '${escapeCqlLiteral(args.rnbId)}'`
      : null;

  if (!filter) {
    return null;
  }

  const url = new URL("https://data.geopf.fr/wfs/ows");
  url.searchParams.set("service", "WFS");
  url.searchParams.set("version", "2.0.0");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("typeNames", "BDTOPO_V3:batiment");
  url.searchParams.set("outputFormat", "application/json");
  url.searchParams.set("count", "1");
  url.searchParams.set("CQL_FILTER", filter);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`BD TOPO request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as BdTopoFeatureResponse;
  const feature = Array.isArray(payload.features)
    ? payload.features[0]
    : undefined;
  return normalizeBdTopoFeature(feature);
}

async function fetchBdnbRows(
  table: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const url = new URL(`https://api.bdnb.io/v1/bdnb/donnees/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `BDNB request failed for ${table} with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload)
    ? payload.filter(
        (row): row is Record<string, unknown> =>
          row !== null && typeof row === "object",
      )
    : [];
}

async function fetchBdnbBuildingEnrichment(
  rnbId: string,
): Promise<BdnbBuildingEnrichmentResponse | null> {
  const constructionLookup = await fetchBdnbRows("batiment_construction", {
    select: "batiment_groupe_id",
    limit: "1",
    rnb_id: `eq.${rnbId}`,
  });

  const batimentGroupeId = parseUnknownString(
    constructionLookup[0]?.batiment_groupe_id,
  );
  if (!batimentGroupeId) {
    return null;
  }

  const [ffoRows, argilesRows, dpeRows] = await Promise.all([
    fetchBdnbRows("batiment_groupe_ffo_bat", {
      limit: "1",
      batiment_groupe_id: `eq.${batimentGroupeId}`,
    }),
    fetchBdnbRows("batiment_groupe_argiles", {
      limit: "1",
      batiment_groupe_id: `eq.${batimentGroupeId}`,
    }),
    fetchBdnbRows("rel_batiment_groupe_dpe_logement_complet", {
      limit: "1",
      batiment_groupe_id: `eq.${batimentGroupeId}`,
    }),
  ]);

  const ffo = ffoRows[0] ?? {};
  const argiles = argilesRows[0] ?? {};
  const dpe = dpeRows[0] ?? {};

  return {
    batimentGroupeId,
    constructionYear: parseUnknownNumber(ffo.annee_construction),
    wallMaterial: parseUnknownString(ffo.mat_mur_txt),
    clayRisk: parseUnknownString(argiles.alea),
    heatingType: parseUnknownString(dpe.type_generateur_chauffage),
    dpeClass: parseUnknownString(dpe.classe_bilan_dpe),
    gesClass: parseUnknownString(dpe.classe_emission_ges),
  };
}

export const buildingRoutes = Router();

buildingRoutes.get("/rnb", async (req, res) => {
  const bbox = typeof req.query.bbox === "string" ? req.query.bbox : null;
  if (!bbox) {
    res.status(400).json({ error: "bbox query parameter is required" });
    return;
  }

  const parts = bbox.split(",").map((value) => Number.parseFloat(value));
  if (parts.length !== 4 || !parts.every((value) => Number.isFinite(value))) {
    res.status(400).json({ error: "bbox must be west,south,east,north" });
    return;
  }

  const [west, south, east, north] = parts;
  if (west >= east || south >= north) {
    res.status(400).json({ error: "bbox bounds are invalid" });
    return;
  }

  try {
    const buildings = await fetchRnbBuildingsForBbox(west, south, east, north);
    res.json({ buildings: buildings.slice(0, 120) });
  } catch (error) {
    console.error("RNB layer error:", error);
    res.status(502).json({ error: "Failed to load RNB buildings" });
  }
});

buildingRoutes.post("/bdtopo-match", async (req, res) => {
  const { rnbId, bdTopoId } = (req.body ?? {}) as {
    rnbId?: unknown;
    bdTopoId?: unknown;
  };

  const normalizedRnbId = typeof rnbId === "string" ? rnbId : undefined;
  const normalizedBdTopoId =
    typeof bdTopoId === "string" ? bdTopoId : undefined;

  if (!normalizedRnbId && !normalizedBdTopoId) {
    res.status(400).json({ error: "rnbId or bdTopoId is required" });
    return;
  }

  try {
    const building = await fetchBdTopoBuildingMatch({
      rnbId: normalizedRnbId,
      bdTopoId: normalizedBdTopoId,
    });
    res.json({ building });
  } catch (error) {
    console.error("BD TOPO match error:", error);
    res.status(502).json({ error: "Failed to query BD TOPO" });
  }
});

buildingRoutes.post("/bdnb-enrich", async (req, res) => {
  const { rnbId } = (req.body ?? {}) as {
    rnbId?: unknown;
  };

  const normalizedRnbId = typeof rnbId === "string" ? rnbId : undefined;
  if (!normalizedRnbId) {
    res.status(400).json({ error: "rnbId is required" });
    return;
  }

  try {
    const building = await fetchBdnbBuildingEnrichment(normalizedRnbId);
    res.json({ building });
  } catch (error) {
    console.error("BDNB enrich error:", error);
    res.status(502).json({ error: "Failed to query BDNB" });
  }
});

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
