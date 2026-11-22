// ─── Finora AI Hub — Provider Registry ─────────────────────────
//
// The gateway and router request AI completions by provider ID through this
// registry. Keys are read from Deno.env and passed to adapters — they are
// never logged, never returned, and never reach the frontend.

import type { ProviderAdapter } from "./providerAdapter.ts";
import { openaiAdapter } from "./adapters/openai.ts";
import { geminiAdapter } from "./adapters/gemini.ts";
import { anthropicAdapter } from "./adapters/anthropic.ts";
import {
  groqAdapter,
  openRouterAdapter,
  deepSeekAdapter,
  mistralAdapter,
} from "./adapters/builtInOpenAICompatible.ts";
import { AiProviderError } from "./errors.ts";
import type { AiChatRequest, AiChatResponse } from "./types.ts";

const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
  groq: groqAdapter,
  openrouter: openRouterAdapter,
  deepseek: deepSeekAdapter,
  mistral: mistralAdapter,
};

export function isProviderRegistered(providerId: string): boolean {
  return providerId in ADAPTERS;
}

export function getRegisteredProviderIds(): string[] {
  return Object.keys(ADAPTERS);
}

/**
 * True when the provider has a registered adapter AND its API key secret is
 * configured. Used by the router to skip unconfigured providers without
 * attempting a network call.
 */
export function hasProviderSecret(providerId: string): boolean {
  const adapter = ADAPTERS[providerId];
  if (!adapter) return false;
  const key = Deno.env.get(adapter.apiKeyEnvName);
  return typeof key === "string" && key.length > 0;
}

/**
 * Execute a chat completion via the registered provider.
 * Throws AiProviderError when the provider is unknown or the call fails.
 */
export async function chatViaProvider(request: AiChatRequest): Promise<AiChatResponse> {
  const adapter = ADAPTERS[request.providerId];
  if (!adapter) {
    throw new AiProviderError({
      code: "unknown",
      providerId: request.providerId,
      message: `Provider "${request.providerId}" is not registered.`,
    });
  }

  const apiKey = Deno.env.get(adapter.apiKeyEnvName);
  if (!apiKey) {
    throw new AiProviderError({
      code: "authentication",
      providerId: adapter.id,
      message: `Secret ${adapter.apiKeyEnvName} is not configured.`,
    });
  }

  return adapter.chat(request, apiKey);
}
