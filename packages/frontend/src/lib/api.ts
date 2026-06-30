import type {
  AdminUser,
  MissionConfig,
  Obstacle,
  PaginatedResponse,
  PointOfInterest,
  Waypoint,
} from "@droneroute/shared";
import { useMissionStore } from "@/store/missionStore";
import { useAuthStore } from "@/store/authStore";

const API_BASE = "/api";

export interface DetectedBuilding {
  id: string;
  footprint: Array<{ lat: number; lng: number }>;
  centroid: { lat: number; lng: number };
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

export interface DetectBuildingResponse {
  building: DetectedBuilding;
  candidates: DetectedBuilding[];
}

export interface RnbBuildingExternalId {
  id: string;
  source: string;
  createdAt: string | null;
  sourceVersion: string | null;
}

export interface RnbBuilding {
  rnbId: string;
  status: string | null;
  point: { lat: number; lng: number };
  footprint: Array<{ lat: number; lng: number }>;
  extIds: RnbBuildingExternalId[];
  bdTopoId: string | null;
  isActive: boolean;
  addressCount: number;
}

export interface RnbBuildingsResponse {
  buildings: RnbBuilding[];
}

export interface BdTopoMatchedBuilding {
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
  centroid: { lat: number; lng: number };
  footprint: Array<{ lat: number; lng: number }>;
}

export interface BdTopoMatchedBuildingResponse {
  building: BdTopoMatchedBuilding | null;
}

export interface BdnbBuildingEnrichment {
  batimentGroupeId: string | null;
  constructionYear: number | null;
  wallMaterial: string | null;
  clayRisk: string | null;
  heatingType: string | null;
  dpeClass: string | null;
  gesClass: string | null;
}

export interface BdnbBuildingEnrichmentResponse {
  building: BdnbBuildingEnrichment | null;
}

export type FacadeCopilotObjective =
  | "balanced"
  | "inspection"
  | "reconstruction"
  | "speed";

export interface FacadeRecommendationVariantInput {
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

export interface FacadeCopilotRecommendation {
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

export interface MissionAssistantSuggestedAction {
  label: string;
  detail: string;
}

export type MissionAssistantTemplateMode =
  | "orbit"
  | "grid"
  | "facade"
  | "pencil"
  | null;

export interface MissionAssistantResponse {
  answer: string;
  bullets: string[];
  warnings: string[];
  suggestedActions: MissionAssistantSuggestedAction[];
  source: "github-models" | "openai-compatible";
  usedModel: string | null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem("droneroute_token");
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (!(options?.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));

    // Handle banned user — force logout
    if (res.status === 403 && err.banned) {
      localStorage.removeItem("droneroute_token");
      localStorage.removeItem("droneroute_email");
      localStorage.removeItem("droneroute_is_admin");
      useMissionStore.getState().clearMission();
      window.location.reload();
      throw new Error(err.error || "Your account has been suspended");
    }

    // Handle unverified email — trigger verification gate
    if (res.status === 403 && err.code === "EMAIL_NOT_VERIFIED") {
      useAuthStore.getState().setNeedsVerification(true);
      throw new Error(err.error || "Email not verified");
    }

    throw new Error(err.error || "Request failed");
  }

  // Check if response is JSON or binary
  const contentType = res.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return res.json();
  }

  return res.blob() as any;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: any) =>
    request<T>(path, {
      method: "POST",
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),
  put: <T>(path: string, body?: any) =>
    request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export const buildingApi = {
  detectNearest: (body: { lat: number; lng: number; radiusM?: number }) =>
    api.post<DetectBuildingResponse>("/buildings/detect", body),
  listRnbBuildings: (bbox: [number, number, number, number]) =>
    api.get<RnbBuildingsResponse>(`/buildings/rnb?bbox=${bbox.join(",")}`),
  matchBdTopoBuilding: (body: { rnbId?: string; bdTopoId?: string | null }) =>
    api.post<BdTopoMatchedBuildingResponse>("/buildings/bdtopo-match", body),
  enrichBdnbBuilding: (body: { rnbId: string }) =>
    api.post<BdnbBuildingEnrichmentResponse>("/buildings/bdnb-enrich", body),
  recommendFacadeScan: (body: {
    objective?: FacadeCopilotObjective;
    currentVariantId?: string | null;
    building: Pick<
      DetectedBuilding,
      "id" | "estimatedHeightM" | "source" | "distanceToQueryM"
    >;
    selectedSegment: {
      id: string;
      label: string;
      lengthM: number;
      distanceToHintM: number;
      angleDeltaDeg: number;
      score: number;
    };
    variants: FacadeRecommendationVariantInput[];
  }) =>
    api.post<FacadeCopilotRecommendation>(
      "/buildings/recommend-facade-scan",
      body,
    ),
};

export const missionAssistantApi = {
  analyzeMission: (body: {
    prompt: string;
    missionName: string;
    templateMode: MissionAssistantTemplateMode;
    config: MissionConfig;
    waypoints: Waypoint[];
    pois: PointOfInterest[];
    obstacles: Obstacle[];
  }) => api.post<MissionAssistantResponse>("/assistant/mission", body),
};

// Admin API
export const adminApi = {
  getUsers: (
    params: {
      page?: number;
      perPage?: number;
      search?: string;
      status?: string;
      sortBy?: string;
      sortOrder?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.page) query.set("page", String(params.page));
    if (params.perPage) query.set("perPage", String(params.perPage));
    if (params.search) query.set("search", params.search);
    if (params.status) query.set("status", params.status);
    if (params.sortBy) query.set("sortBy", params.sortBy);
    if (params.sortOrder) query.set("sortOrder", params.sortOrder);
    return api.get<PaginatedResponse<AdminUser>>(
      `/admin/users?${query.toString()}`,
    );
  },
  banUser: (id: string) =>
    api.post<{ message: string }>(`/admin/users/${id}/ban`),
  unbanUser: (id: string) =>
    api.post<{ message: string }>(`/admin/users/${id}/unban`),
  promoteUser: (id: string) =>
    api.post<{ message: string }>(`/admin/users/${id}/promote`),
  demoteUser: (id: string) =>
    api.post<{ message: string }>(`/admin/users/${id}/demote`),
};
