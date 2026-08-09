import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderProbeUrl,
  classifyProviderProbeResponse,
  resolveProviderProbeEndpoint,
  validateProviderProbeInputs,
} from "./providerConnectionProbe";

test("resolveProviderProbeEndpoint follows style conventions including Google /models", () => {
  assert.equal(resolveProviderProbeEndpoint("openai"), "/models");
  assert.equal(resolveProviderProbeEndpoint("anthropic"), "/v1/models");
  assert.equal(resolveProviderProbeEndpoint("google"), "/models");
  assert.equal(resolveProviderProbeEndpoint("openai", "/custom"), "/models");
  assert.equal(resolveProviderProbeEndpoint("google", "/custom/list"), "/models");
});

test("buildProviderProbeUrl joins base URL and endpoint without duplicate slashes", () => {
  assert.equal(
    buildProviderProbeUrl("https://api.deepseek.com/v1/", "/models"),
    "https://api.deepseek.com/v1/models",
  );
  assert.equal(
    buildProviderProbeUrl("https://api.anthropic.com", "/v1/models"),
    "https://api.anthropic.com/v1/models",
  );
});

test("validateProviderProbeInputs requires base URL and API key except for ollama", () => {
  assert.deepEqual(
    validateProviderProbeInputs({ baseURL: "", apiKey: "sk", providerId: "openai" }),
    { ok: false, reason: "missing_base_url" },
  );
  assert.deepEqual(
    validateProviderProbeInputs({ baseURL: "https://api.openai.com/v1", apiKey: "", providerId: "openai" }),
    { ok: false, reason: "missing_api_key" },
  );
  assert.deepEqual(
    validateProviderProbeInputs({ baseURL: "http://localhost:11434/v1", apiKey: "", providerId: "ollama" }),
    { ok: true },
  );
});

test("classifyProviderProbeResponse marks auth and transport failures as error", () => {
  assert.equal(
    classifyProviderProbeResponse({ ok: false, status: 401, latencyMs: 120, error: "Unauthorized" }).health,
    "error",
  );
  assert.equal(
    classifyProviderProbeResponse({ ok: false, status: 0, latencyMs: 30, error: "Request timeout" }).health,
    "error",
  );
});

test("classifyProviderProbeResponse marks 2xx with models payload as ok", () => {
  const result = classifyProviderProbeResponse({
    ok: true,
    status: 200,
    latencyMs: 180,
    data: JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
  });
  assert.equal(result.health, "ok");
  assert.equal(result.latencyMs, 180);
  assert.equal(result.statusCode, 200);
  assert.equal(result.modelCount, 1);
});

test("classifyProviderProbeResponse marks slow or empty success as warn", () => {
  assert.equal(
    classifyProviderProbeResponse({
      ok: true,
      status: 200,
      latencyMs: 4500,
      data: JSON.stringify({ data: [{ id: "m" }] }),
      slowThresholdMs: 3000,
    }).health,
    "warn",
  );
  assert.equal(
    classifyProviderProbeResponse({
      ok: true,
      status: 200,
      latencyMs: 100,
      data: JSON.stringify({ data: [] }),
    }).health,
    "warn",
  );
});

test("classifyProviderProbeResponse accepts Google ListModels name-only entries", () => {
  const result = classifyProviderProbeResponse({
    ok: true,
    status: 200,
    latencyMs: 220,
    data: JSON.stringify({ models: [{ name: "models/gemini-2.0-flash" }] }),
  });
  assert.equal(result.health, "ok");
  assert.equal(result.modelCount, 1);
});
