import type { ProviderStyle } from "./types";
import { STYLE_DEFAULT_MODELS_ENDPOINT } from "./modelDiscoveryHeaders";

export type ProviderProbeHealth = "ok" | "warn" | "error";

export type ProviderProbeInputIssue = "missing_base_url" | "missing_api_key";

export type ProviderProbeClassification = {
  health: ProviderProbeHealth;
  latencyMs: number;
  statusCode: number;
  modelCount?: number;
  error?: string;
};

/**
 * Probe-specific discovery path. Same conventions as model listing, but Google
 * Generative Language exposes `GET /models`, so the settings "Test" button can
 * validate key + connectivity without opening chat.
 */
export function resolveProviderProbeEndpoint(
  style: ProviderStyle,
  presetEndpoint?: string,
): string | undefined {
  if (style === "google") return "/models";
  return STYLE_DEFAULT_MODELS_ENDPOINT[style] ?? presetEndpoint;
}

export function buildProviderProbeUrl(baseURL: string, endpoint: string): string {
  return `${baseURL.replace(/\/+$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

export function validateProviderProbeInputs(input: {
  baseURL: string;
  apiKey: string;
  providerId: string;
}): { ok: true } | { ok: false; reason: ProviderProbeInputIssue } {
  if (!input.baseURL.trim()) return { ok: false, reason: "missing_base_url" };
  const needsApiKey = input.providerId !== "ollama";
  if (needsApiKey && !input.apiKey.trim()) return { ok: false, reason: "missing_api_key" };
  return { ok: true };
}

function countModelsInPayload(data: string | undefined): number | undefined {
  if (data == null || data.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const rawModels = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : null;
    if (!rawModels) return undefined;
    return rawModels.filter((raw) => {
      if (!raw || typeof raw !== "object") return false;
      const model = raw as Record<string, unknown>;
      // OpenAI-compat uses `id`; Google ListModels uses `name` (e.g. models/gemini-…).
      return (typeof model.id === "string" && model.id.length > 0)
        || (typeof model.name === "string" && model.name.length > 0);
    }).length;
  } catch {
    return undefined;
  }
}

/**
 * Map a lightweight `/models` (or equivalent) probe response to green / yellow / red.
 * Yellow covers slow-but-successful replies and empty model catalogs.
 */
export function classifyProviderProbeResponse(input: {
  ok: boolean;
  status: number;
  latencyMs: number;
  data?: string;
  error?: string;
  slowThresholdMs?: number;
}): ProviderProbeClassification {
  const slowThresholdMs = input.slowThresholdMs ?? 3000;
  const base = {
    latencyMs: input.latencyMs,
    statusCode: input.status,
    ...(input.error ? { error: input.error } : {}),
  };

  if (!input.ok || input.status < 200 || input.status >= 300) {
    return {
      ...base,
      health: "error",
      error: input.error || (input.status ? `HTTP ${input.status}` : "Request failed"),
    };
  }

  const modelCount = countModelsInPayload(input.data);
  if (modelCount === undefined) {
    return {
      ...base,
      health: "warn",
      error: "Unexpected response body",
    };
  }
  if (modelCount === 0 || input.latencyMs >= slowThresholdMs) {
    return {
      ...base,
      health: "warn",
      modelCount,
    };
  }
  return {
    ...base,
    health: "ok",
    modelCount,
  };
}
