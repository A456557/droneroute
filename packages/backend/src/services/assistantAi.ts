type SuggestedAction = {
  label: string;
  detail: string;
};

export type AssistantResponseDraft = {
  answer: string;
  bullets: string[];
  warnings: string[];
  suggestedActions: SuggestedAction[];
};

export type AssistantResponseSource =
  | "github-models"
  | "openai-compatible"
  | "ollama";

export type AssistantAiResponse = AssistantResponseDraft & {
  source: AssistantResponseSource;
  usedModel: string;
};

export class AssistantAiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantAiConfigError";
  }
}

type ProviderConfig =
  | {
      provider: "github-models";
      endpoint: string;
      token: string;
      model: string;
      apiVersion: string;
    }
  | {
      provider: "openai-compatible";
      endpoint: string;
      token: string;
      model: string;
    }
  | {
      provider: "ollama";
      endpoint: string;
      token: string;
      model: string;
    };

type GenerateMissionAssistantParams = {
  missionName: string;
  prompt: string;
  templateMode: string | null;
  profile: string;
  focus: Record<string, boolean>;
  stats: Record<string, number | string | boolean | null>;
  maxBatteryMinutes: number;
  draft: AssistantResponseDraft;
  terrain?: {
    groundMinM: number | null;
    groundMaxM: number | null;
    reliefM: number | null;
    aglMinM: number | null;
    aglMaxM: number | null;
    coveragePct: number | null;
    source: string;
  } | null;
  site?: {
    meteo: {
      windMs: number | null;
      gustsMs: number | null;
      precipitationMm: number | null;
      weatherCode: number | null;
      label: string;
    } | null;
    parcelle: {
      commune: string | null;
      section: string | null;
      numero: string | null;
      contenanceM2: number | null;
    } | null;
    urbanisme: {
      documentType: string | null;
      zoneLibelle: string | null;
      zoneLibelleLong: string | null;
    } | null;
    airspace: {
      prohibited: number;
      restricted: number;
      names: string[];
    } | null;
  } | null;
};

const GITHUB_MODELS_ENDPOINT =
  "https://models.github.ai/inference/chat/completions";
const GITHUB_MODELS_API_VERSION = "2026-03-10";
const GITHUB_MODELS_DEFAULT_MODEL = "openai/gpt-4.1";
const OPENAI_COMPATIBLE_DEFAULT_ENDPOINT =
  "https://api.openai.com/v1/chat/completions";
// Ollama local (modèles open-source : mistral, llama3.1, qwen2.5...).
// En Docker, utiliser http://ollama:11434/v1/chat/completions.
const OLLAMA_DEFAULT_ENDPOINT = "http://localhost:11434/v1/chat/completions";
const OLLAMA_DEFAULT_MODEL = "mistral:latest";

function trimStringArray(
  value: unknown,
  fallback: string[],
  maxItems: number,
): string[] {
  if (!Array.isArray(value)) {
    return fallback.slice(0, maxItems);
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);

  return normalized.length > 0 ? normalized : fallback.slice(0, maxItems);
}

function normalizeSuggestedActions(
  value: unknown,
  fallback: SuggestedAction[],
  maxItems: number,
): SuggestedAction[] {
  if (!Array.isArray(value)) {
    return fallback.slice(0, maxItems);
  }

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const label =
        typeof (item as SuggestedAction).label === "string"
          ? (item as SuggestedAction).label.trim()
          : "";
      const detail =
        typeof (item as SuggestedAction).detail === "string"
          ? (item as SuggestedAction).detail.trim()
          : "";

      return label && detail ? { label, detail } : null;
    })
    .filter((item): item is SuggestedAction => item !== null)
    .slice(0, maxItems);

  return normalized.length > 0 ? normalized : fallback.slice(0, maxItems);
}

function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const provider = env.AI_PROVIDER?.trim();

  // 100% open-source local : Ollama + Mistral/Llama (endpoint OpenAI-compatible).
  // Ex : AI_PROVIDER=ollama AI_MODEL=mistral:latest ollama pull mistral
  if (provider === "ollama") {
    return {
      provider: "ollama",
      endpoint: env.AI_API_URL?.trim() || OLLAMA_DEFAULT_ENDPOINT,
      token: env.AI_API_KEY?.trim() || "ollama",
      model: env.AI_MODEL?.trim() || OLLAMA_DEFAULT_MODEL,
    };
  }

  if (provider === "github-models" || (!provider && env.GITHUB_MODELS_TOKEN)) {
    if (!env.GITHUB_MODELS_TOKEN) {
      throw new AssistantAiConfigError(
        "Mission assistant AI provider is not configured: GITHUB_MODELS_TOKEN is required.",
      );
    }

    return {
      provider: "github-models",
      endpoint: env.GITHUB_MODELS_ENDPOINT?.trim() || GITHUB_MODELS_ENDPOINT,
      token: env.GITHUB_MODELS_TOKEN,
      model: env.GITHUB_MODELS_MODEL?.trim() || GITHUB_MODELS_DEFAULT_MODEL,
      apiVersion:
        env.GITHUB_MODELS_API_VERSION?.trim() || GITHUB_MODELS_API_VERSION,
    };
  }

  if (
    provider === "openai-compatible" ||
    (!provider && env.AI_API_KEY && env.AI_MODEL)
  ) {
    if (!env.AI_API_KEY || !env.AI_MODEL) {
      throw new AssistantAiConfigError(
        "Mission assistant AI provider is not configured: AI_API_KEY and AI_MODEL are required for an OpenAI-compatible backend.",
      );
    }

    return {
      provider: "openai-compatible",
      endpoint: env.AI_API_URL?.trim() || OPENAI_COMPATIBLE_DEFAULT_ENDPOINT,
      token: env.AI_API_KEY,
      model: env.AI_MODEL,
    };
  }

  throw new AssistantAiConfigError(
    "Mission assistant AI provider is not configured. Set AI_PROVIDER=ollama (local Mistral via Ollama, recommandé open-source), AI_PROVIDER=github-models with GITHUB_MODELS_TOKEN, or AI_PROVIDER=openai-compatible with AI_API_KEY and AI_MODEL.",
  );
}

function buildMessages(params: GenerateMissionAssistantParams) {
  const terrainLine = params.terrain
    ? `Terrain IGN (${params.terrain.source}): sol ${params.terrain.groundMinM ?? "?"}..${params.terrain.groundMaxM ?? "?"} m, relief ${params.terrain.reliefM ?? "?"} m, AGL ${params.terrain.aglMinM ?? "?"}..${params.terrain.aglMaxM ?? "?"} m, couverture MNT ${params.terrain.coveragePct ?? 0}%.`
    : "Terrain IGN indisponible pour cette mission.";
  const siteLine = params.site
    ? `Site: météo ${params.site.meteo ? `${params.site.meteo.label}, vent ${params.site.meteo.windMs ?? "?"} m/s, rafales ${params.site.meteo.gustsMs ?? "?"} m/s, pluie ${params.site.meteo.precipitationMm ?? "?"} mm` : "indisponible"} ; parcelle ${params.site.parcelle ? `${params.site.parcelle.commune ?? "?"} section ${params.site.parcelle.section ?? "?"} n°${params.site.parcelle.numero ?? "?"}` : "hors cadastre"} ; urbanisme ${params.site.urbanisme ? `${params.site.urbanisme.documentType ?? "?"} zone ${params.site.urbanisme.zoneLibelle ?? "?"} (${params.site.urbanisme.zoneLibelleLong ?? "?"})` : "inconnu"} ; espace aérien ${params.site.airspace ? `${params.site.airspace.prohibited} interdite(s), ${params.site.airspace.restricted} restreinte(s) au centroïde` : "inconnu"}.`
    : "Contexte site indisponible.";
  return [
    {
      role: "system",
      content:
        "You are DroneRoute's mission planning assistant for construction-site (chantier) analysis. Answer in French only. Use only the mission context provided by the server. Be operational, concrete, and concise. Vérifie que le trajet drone est adapté au relief : AGL constant, marges obstacles, pente/terrassement, autonomie. Do not invent drone, weather, camera, or terrain details that are not present in the input.",
    },
    {
      role: "developer",
      content:
        'Return strict JSON with this shape: {"answer": string, "bullets": string[], "warnings": string[], "suggestedActions": [{"label": string, "detail": string}]}. Keep exactly 4 bullets maximum, 3 warnings maximum, and 3 suggestedActions maximum. Keep the answer under 120 words. Prefer the mission-specific facts from the snapshot. If some fields are weakly supported, refine the provided draft instead of inventing data.',
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Analyze the mission and improve the server draft for the end user. Check that the drone path fits the terrain.",
          missionName: params.missionName,
          userPrompt: params.prompt,
          templateMode: params.templateMode,
          missionProfile: params.profile,
          focus: params.focus,
          stats: params.stats,
          terrain: params.terrain ?? null,
          site: params.site ?? null,
          terrainHint: terrainLine,
          siteHint: siteLine,
          maxBatteryMinutes: params.maxBatteryMinutes,
          draft: params.draft,
        },
        null,
        2,
      ),
    },
  ];
}

function normalizeResponse(
  raw: unknown,
  draft: AssistantResponseDraft,
  provider: AssistantAiResponse["source"],
  model: string,
): AssistantAiResponse {
  const payload =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const answer =
    typeof payload.answer === "string" && payload.answer.trim().length > 0
      ? payload.answer.trim()
      : draft.answer;

  return {
    answer,
    bullets: trimStringArray(payload.bullets, draft.bullets, 4),
    warnings: trimStringArray(payload.warnings, draft.warnings, 3),
    suggestedActions: normalizeSuggestedActions(
      payload.suggestedActions,
      draft.suggestedActions,
      3,
    ),
    source: provider,
    usedModel: model,
  };
}

async function requestChatCompletion(
  config: ProviderConfig,
  body: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };

  if (config.provider === "github-models") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = config.apiVersion;
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Mission assistant provider error (${response.status}): ${errorText || response.statusText}`,
    );
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Mission assistant provider returned an empty response.");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Mission assistant provider returned invalid JSON.");
  }
}

export async function generateMissionAssistantResponse(
  params: GenerateMissionAssistantParams,
): Promise<AssistantAiResponse> {
  const config = resolveProviderConfig();
  const payload = await requestChatCompletion(config, {
    model: config.model,
    messages: buildMessages(params),
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 700,
  });

  return normalizeResponse(
    payload,
    params.draft,
    config.provider,
    config.model,
  );
}
