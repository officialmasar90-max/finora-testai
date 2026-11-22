// ─── Finora AI Hub — Built-in OpenAI-Compatible Providers ──────
//
// Instantiates the shared factory for each provider that speaks the OpenAI
// wire format. Model IDs and base URLs follow each provider's published API.

import { createOpenAICompatibleAdapter } from "./openaiCompatible.ts";

export const groqAdapter = createOpenAICompatibleAdapter({
  id: "groq",
  displayName: "Groq",
  apiKeyEnvName: "GROQ_API_KEY",
  baseUrl: "https://api.groq.com/openai/v1",
  defaultTimeoutMs: 30_000,
});

export const openRouterAdapter = createOpenAICompatibleAdapter({
  id: "openrouter",
  displayName: "OpenRouter",
  apiKeyEnvName: "OPENROUTER_API_KEY",
  baseUrl: "https://openrouter.ai/api/v1",
  defaultTimeoutMs: 60_000,
});

export const deepSeekAdapter = createOpenAICompatibleAdapter({
  id: "deepseek",
  displayName: "DeepSeek",
  apiKeyEnvName: "DEEPSEEK_API_KEY",
  baseUrl: "https://api.deepseek.com/v1",
  defaultTimeoutMs: 60_000,
});

export const mistralAdapter = createOpenAICompatibleAdapter({
  id: "mistral",
  displayName: "Mistral",
  apiKeyEnvName: "MISTRAL_API_KEY",
  baseUrl: "https://api.mistral.ai/v1",
  defaultTimeoutMs: 45_000,
});
