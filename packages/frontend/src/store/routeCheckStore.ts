import { create } from "zustand";
import { toast } from "sonner";
import type { Waypoint } from "@droneroute/shared";
import type {
  FacadeCheckContext,
  RouteBlockingRules,
  RouteCheckInput,
  RouteCheckReport,
  RouteCheckSummary,
  RouteFinding,
  RouteGlobalStatus,
  RouteReportAi,
} from "@/lib/routeCheck";
import {
  DEFAULT_BLOCKING_RULES,
  containsBannedClaim,
  hashRouteSnapshot,
  runRouteChecks,
} from "@/lib/routeCheck";
import { useMissionStore } from "@/store/missionStore";
import { useAirspaceStore } from "@/store/airspaceStore";
import { missionAssistantApi, type MissionAssistantResponse } from "@/lib/api";
import { terrainApi } from "@/lib/terrain";

/** Contexte façade fourni par MapView (état local non stocké). */
export type FacadeContextProvider = () => FacadeCheckContext | null;

let facadeContextProvider: FacadeContextProvider | null = null;

export function setFacadeContextProvider(
  provider: FacadeContextProvider | null,
): void {
  facadeContextProvider = provider;
}

/** Capture de la vue carte fournie par MapView (dataURL JPEG ou null). */
export type MapCaptureProvider = () => string | null;

let mapCaptureProvider: MapCaptureProvider | null = null;

export function setMapCaptureProvider(
  provider: MapCaptureProvider | null,
): void {
  mapCaptureProvider = provider;
}

/** Capture réduite (960 px) de la carte pour l'analyse visuelle IA. */
export async function captureMapImage(maxWidth = 960): Promise<string | null> {
  try {
    const raw = mapCaptureProvider?.() ?? null;
    if (!raw || !raw.startsWith("data:image/")) return null;
    const bitmap = await createImageBitmap(await (await fetch(raw)).blob());
    try {
      const scale = Math.min(1, maxWidth / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.72);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

export interface FocusRequest {
  lat: number;
  lng: number;
  waypointIndex?: number;
  key: number;
}

interface RouteCheckState {
  report: RouteCheckReport | null;
  running: boolean;
  aiRunning: boolean;
  previewWaypoints: Waypoint[] | null;
  previewSuggestionId: string | null;
  focusRequest: FocusRequest | null;
  blockingRules: RouteBlockingRules;
  /** Refuse l'export en cas d'échec bloquant (désactivé par défaut :
   *  aucune politique de blocage n'existait, l'export reste inchangé). */
  blockExport: boolean;
  lastError: string | null;

  setBlockingRules: (rules: Partial<RouteBlockingRules>) => void;
  setBlockExport: (value: boolean) => void;
  runCheck: () => Promise<void>;
  clearReport: () => void;
  previewSuggestion: (suggestionId: string) => void;
  clearPreview: () => void;
  ignoreFinding: (findingId: string) => void;
  ignoreSuggestion: (suggestionId: string) => void;
  applySuggestion: (suggestionId: string, confirmed: boolean) => void;
  requestFocus: (focus: Omit<FocusRequest, "key">) => void;
  clearFocus: () => void;
}

/** Version synchronisable du parcours (sans terrain, dérivé non éditable). */
export function computeVersionHash(): string {
  const mission = useMissionStore.getState();
  const facade = facadeContextProvider?.() ?? null;
  return hashRouteSnapshot({
    waypoints: mission.waypoints,
    pois: mission.pois,
    obstacles: mission.obstacles,
    config: mission.config,
    templateMode: mission.templateMode,
    facade,
    airspace: { enabled: false, zones: [] },
    terrain: null,
  });
}

export function isReportStale(report: RouteCheckReport | null): boolean {
  if (!report) return false;
  try {
    return computeVersionHash() !== report.versionHash;
  } catch {
    return true;
  }
}

function computeGlobalStatus(
  report: Pick<RouteCheckReport, "findings">,
  rules: RouteBlockingRules,
): RouteGlobalStatus {
  const active = report.findings.filter((f) => f.status !== "ignored");
  const blocking = active.some(
    (f) =>
      f.severity === "error" &&
      ((f.checkId === "R-04" && rules.obstacleConflict) ||
        (f.checkId === "R-07" && rules.prohibitedAirspace) ||
        (f.checkId === "R-08" && rules.terrainCollision) ||
        (f.checkId !== "R-04" && f.checkId !== "R-07" && f.checkId !== "R-08")),
  );
  if (blocking) return "blocked";
  if (
    active.some(
      (f) =>
        f.severity === "error" ||
        f.severity === "warning" ||
        f.severity === "unverified",
    )
  ) {
    return "review";
  }
  return "clear";
}

function validateAiResponse(response: MissionAssistantResponse): {
  ok: boolean;
  reason?: string;
} {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "Réponse IA illisible." };
  }
  if (
    typeof response.answer !== "string" ||
    !Array.isArray(response.suggestedActions)
  ) {
    return { ok: false, reason: "Réponse IA incomplète." };
  }
  for (const action of response.suggestedActions) {
    if (
      !action ||
      typeof action.label !== "string" ||
      typeof action.detail !== "string"
    ) {
      return { ok: false, reason: "Réponse IA incomplète." };
    }
    for (const field of ["target", "justification"] as const) {
      const value = action[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return { ok: false, reason: "Réponse IA incomplète." };
      }
    }
    if (
      action.dataUsed !== undefined &&
      (!Array.isArray(action.dataUsed) ||
        action.dataUsed.some((item) => typeof item !== "string"))
    ) {
      return { ok: false, reason: "Réponse IA incomplète." };
    }
  }
  const texts = [
    response.answer,
    ...response.suggestedActions.map(
      (a) => `${a?.label ?? ""} ${a?.detail ?? ""} ${a?.justification ?? ""}`,
    ),
  ].join("\n");
  if (containsBannedClaim(texts)) {
    return {
      ok: false,
      reason:
        "Réponse IA écartée : elle présente l'analyse comme une autorisation de vol.",
    };
  }
  return { ok: true };
}

function describeTarget(finding: {
  target: { kind: string; index?: number; label?: string };
}): string {
  if (finding.target.kind === "waypoint") {
    return `waypoint ${(finding.target.index ?? 0) + 1}`;
  }
  if (finding.target.kind === "segment") {
    return `segment après waypoint ${(finding.target.index ?? 0) + 1}`;
  }
  if (finding.target.kind === "area") {
    return `zone ${finding.target.label ?? ""}`.trim();
  }
  return "mission entière";
}

async function runAiAnalysis(
  input: RouteCheckInput,
  summary: RouteCheckSummary,
  missionName: string,
  versionHash: string,
  findings: RouteFinding[],
): Promise<RouteReportAi> {
  const waypointText = input.waypoints
    .map(
      (wp, i) =>
        `#${i + 1} (${wp.latitude.toFixed(5)}, ${wp.longitude.toFixed(5)}, ${Math.round(wp.height)} m)`,
    )
    .join(" ; ");
  // Seules les données nécessaires : les constats déterministes sont
  // transmis, pas la mission brute au-delà du besoin.
  const findingsText =
    findings.length > 0
      ? findings
          .map(
            (f) =>
              `[${f.severity}] ${f.label} — ${f.description} (cible : ${describeTarget(f)} ; règle : ${f.rule})`,
          )
          .join("\n")
      : "Aucun constat.";
  const prompt =
    `Contrôle d'un parcours drone (${input.waypoints.length} waypoints, ` +
    `${Math.round(summary.distanceM)} m). Constats déterministes à expliquer :\n${findingsText}\n` +
    `Trajet : ${waypointText}.`;
  const mapImage = await captureMapImage();
  try {
    const response = await missionAssistantApi.analyzeMission({
      prompt,
      missionName,
      templateMode: (input.templateMode ?? null) as
        | "orbit"
        | "grid"
        | "facade"
        | "pencil"
        | null,
      config: input.config,
      waypoints: input.waypoints,
      pois: input.pois,
      obstacles: input.obstacles,
      terrain: null,
      site: null,
      mapImage,
      routeCheck: {
        versionHash,
        findings: findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          label: f.label,
          description: f.description,
          target: describeTarget(f),
        })),
      },
    });
    if (response.source === "local-rules") {
      return {
        status: "unavailable",
        reason: "Suggestions IA indisponibles : aucun fournisseur configuré.",
        actions: [],
      };
    }
    const validation = validateAiResponse(response);
    if (!validation.ok) {
      return {
        status: "invalid",
        reason: validation.reason,
        actions: [],
      };
    }
    return {
      status: "ok",
      explanation: response.answer,
      actions: response.suggestedActions.map((a) => ({
        label: a.label,
        detail: a.detail,
        target: a.target ?? null,
        justification: a.justification ?? null,
        dataUsed: a.dataUsed ?? [],
      })),
      source: response.source,
      usedModel: response.usedModel,
      imageAnalyzed: response.imageAnalyzed ?? false,
    };
  } catch {
    return {
      status: "unavailable",
      reason: "Suggestions IA indisponibles : service injoignable.",
      actions: [],
    };
  }
}

export const useRouteCheckStore = create<RouteCheckState>((set, get) => ({
  report: null,
  running: false,
  aiRunning: false,
  previewWaypoints: null,
  previewSuggestionId: null,
  focusRequest: null,
  blockingRules: { ...DEFAULT_BLOCKING_RULES },
  blockExport: false,
  lastError: null,

  setBlockingRules: (rules) =>
    set((state) => ({
      blockingRules: { ...state.blockingRules, ...rules },
    })),

  setBlockExport: (value) => set({ blockExport: value }),

  runCheck: async () => {
    const mission = useMissionStore.getState();
    if (mission.waypoints.length < 2) return;
    const airspace = useAirspaceStore.getState();
    const facade = facadeContextProvider?.() ?? null;
    set({
      running: true,
      aiRunning: true,
      lastError: null,
      previewWaypoints: null,
      previewSuggestionId: null,
    });
    try {
      // Profil MNT (facultatif : Non vérifié si indisponible).
      let terrain: RouteCheckInput["terrain"] = null;
      let terrainSource = "MNT IGN";
      try {
        const profile = await terrainApi.profile(
          mission.waypoints.map((wp) => ({
            lat: wp.latitude,
            lon: wp.longitude,
          })),
        );
        terrainSource = profile.source || terrainSource;
        terrain = {
          grounds: profile.samples.map((s) => s.groundM),
          source: terrainSource,
        };
      } catch {
        terrain = null;
      }

      const input: RouteCheckInput = {
        waypoints: mission.waypoints,
        pois: mission.pois,
        obstacles: mission.obstacles,
        config: mission.config,
        templateMode: mission.templateMode,
        facade,
        airspace: { enabled: airspace.enabled, zones: airspace.zones },
        terrain,
      };
      const versionHash = hashRouteSnapshot(input);
      const { findings, suggestions, summary } = runRouteChecks(input);
      const globalStatus = computeGlobalStatus(
        { findings },
        get().blockingRules,
      );
      const report: RouteCheckReport = {
        id: `report-${Date.now()}`,
        versionHash,
        createdAtISO: new Date().toISOString(),
        summary,
        findings,
        suggestions,
        ai: {
          status: "unavailable",
          reason: "Analyse IA en cours…",
          actions: [],
        },
        globalStatus,
      };
      set({ report, running: false });

      const ai = await runAiAnalysis(
        input,
        summary,
        mission.missionName || "Mission",
        versionHash,
        findings,
      );
      const current = get().report;
      if (current && current.id === report.id) {
        set({ report: { ...current, ai }, aiRunning: false });
      } else {
        set({ aiRunning: false });
      }
    } catch (error) {
      set({
        running: false,
        aiRunning: false,
        lastError:
          error instanceof Error
            ? error.message
            : "Contrôle impossible pour le moment.",
      });
      toast.error("Contrôle indisponible : réessayez.");
    }
  },

  clearReport: () =>
    set({
      report: null,
      previewWaypoints: null,
      previewSuggestionId: null,
      lastError: null,
    }),

  previewSuggestion: (suggestionId) => {
    const { report } = get();
    const suggestion = report?.suggestions.find((s) => s.id === suggestionId);
    if (!report || !suggestion || !suggestion.previewWaypoints) return;
    if (isReportStale(report)) {
      toast.error(
        "Rapport périmé : relancez le contrôle avant de prévisualiser.",
      );
      return;
    }
    set({
      previewWaypoints: suggestion.previewWaypoints,
      previewSuggestionId: suggestionId,
    });
    toast.info("Prévisualisation : la mission n'est pas modifiée.");
  },

  clearPreview: () =>
    set({ previewWaypoints: null, previewSuggestionId: null }),

  ignoreFinding: (findingId) =>
    set((state) => {
      if (!state.report) return state;
      const findings = state.report.findings.map((f) =>
        f.id === findingId ? { ...f, status: "ignored" as const } : f,
      );
      const report = {
        ...state.report,
        findings,
        globalStatus: computeGlobalStatus({ findings }, state.blockingRules),
      };
      return { report };
    }),

  ignoreSuggestion: (suggestionId) =>
    set((state) => {
      if (!state.report) return state;
      const suggestions = state.report.suggestions.map((s) =>
        s.id === suggestionId ? { ...s, status: "ignored" as const } : s,
      );
      return { report: { ...state.report, suggestions } };
    }),

  applySuggestion: (suggestionId, confirmed) => {
    const { report } = get();
    if (!report) return;
    if (isReportStale(report)) {
      toast.error("Rapport périmé : relancez le contrôle avant d'appliquer.");
      return;
    }
    const suggestion = report.suggestions.find((s) => s.id === suggestionId);
    if (!suggestion || suggestion.status !== "proposed") return;
    if (
      suggestion.kind !== "remove-waypoint" ||
      suggestion.targetWaypointIndex == null
    ) {
      toast.error(
        "Suggestion non applicable automatiquement : modifiez manuellement.",
      );
      return;
    }
    if (!confirmed) return;
    useMissionStore.getState().removeWaypoint(suggestion.targetWaypointIndex);
    set((state) => {
      if (!state.report) return state;
      const suggestions = state.report.suggestions.map((s) =>
        s.id === suggestionId ? { ...s, status: "applied" as const } : s,
      );
      const findings = state.report.findings.map((f) =>
        f.id === suggestion.findingId
          ? { ...f, status: "ignored" as const }
          : f,
      );
      return {
        report: {
          ...state.report,
          suggestions,
          findings,
          globalStatus: computeGlobalStatus({ findings }, state.blockingRules),
        },
        previewWaypoints: null,
        previewSuggestionId: null,
      };
    });
    toast.success("Suggestion appliquée : nouvel état du parcours.");
  },

  requestFocus: (focus) => set({ focusRequest: { ...focus, key: Date.now() } }),

  clearFocus: () => set({ focusRequest: null }),
}));
