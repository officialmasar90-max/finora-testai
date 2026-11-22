// ─── Finora AI Hub — Provider Adapter Contract ─────────────────
//
// Every AI provider (OpenAI today; Gemini, Groq, OpenRouter tomorrow) must
// implement this interface. The gateway only ever talks to adapters through
// this contract, never to a provider directly.

import type { AiChatRequest, AiChatResponse } from "./types.ts";

export interface ProviderAdapter {
  /** Stable provider identifier, e.g. "openai". */
  readonly id: string;

  /** Human-readable provider name for logging/display. */
  readonly displayName: string;

  /**
   * Name of the Supabase secret (Deno.env) that holds this provider's API key.
   * The key itself is read by the registry and passed here — never logged.
   */
  readonly apiKeyEnvName: string;

  /** Execute a chat completion. Throws AiProviderError on any failure. */
  chat(request: AiChatRequest, apiKey: string): Promise<AiChatResponse>;
}
