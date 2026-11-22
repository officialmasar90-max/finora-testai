// ─── Finora AI Hub — OpenAI-Compatible Adapter Factory ─────────
//
// Several providers (Groq, OpenRouter, DeepSeek, Mistral) expose a chat
// completions API with the same wire format as OpenAI. This factory builds
// an adapter for each of them so the wire logic is written exactly once.
// Provider-specific quirks (auth header, base URL) are passed in as config.

import type { ProviderAdapter } from "../providerAdapter.ts";
import { AiProviderError, codeFromStatus } from "../errors.ts";
import type { AiChatRequest, AiChatResponse } from "../types.ts";

export interface OpenAICompatibleConfig {
  id: string;
  displayName: string;
  apiKeyEnvName: string;
  baseUrl: string;
  defaultTimeoutMs?: number;
}

export function createOpenAICompatibleAdapter(cfg: OpenAICompatibleConfig): ProviderAdapter {
  return {
    id: cfg.id,
    displayName: cfg.displayName,
    apiKeyEnvName: cfg.apiKeyEnvName,

    async chat(request: AiChatRequest, apiKey: string): Promise<AiChatResponse> {
      const timeoutMs = request.timeoutMs ?? cfg.defaultTimeoutMs ?? 45_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxOutputTokens !== undefined
              ? { max_tokens: request.maxOutputTokens }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new AiProviderError({
            code: "timeout",
            providerId: this.id,
            message: `${cfg.displayName} call exceeded the ${timeoutMs} ms time budget.`,
            retryable: true,
          });
        }
        throw new AiProviderError({
          code: "unknown",
          providerId: this.id,
          message: `Network failure while contacting ${cfg.displayName}: ${err instanceof Error ? err.message : "unknown error"}`,
          retryable: true,
        });
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        throw codeFromStatus(this.id, response.status);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new AiProviderError({
          code: "invalid_response",
          providerId: this.id,
          message: `${cfg.displayName} returned a non-JSON response body.`,
          status: response.status,
        });
      }

      const record = data as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        error?: { message?: string };
      };

      const text = record?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text) {
        throw new AiProviderError({
          code: "invalid_response",
          providerId: this.id,
          message: `${cfg.displayName} response did not contain a usable completion.`,
          status: response.status,
        });
      }

      return {
        text,
        usage: {
          promptTokens: record.usage?.prompt_tokens,
          completionTokens: record.usage?.completion_tokens,
          totalTokens: record.usage?.total_tokens,
        },
        providerId: this.id,
        model: request.model,
        latencyMs,
      };
    },
  };
}
