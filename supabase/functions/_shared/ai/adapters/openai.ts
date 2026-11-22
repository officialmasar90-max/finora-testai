// ─── Finora AI Hub — OpenAI Provider Adapter ───────────────────
//
// All OpenAI-specific communication lives here. The gateway never calls
// api.openai.com directly; it goes through the provider registry, which
// dispatches to this adapter.

import type { ProviderAdapter } from "../providerAdapter.ts";
import { AiProviderError, codeFromStatus } from "../errors.ts";
import type { AiChatRequest, AiChatResponse } from "../types.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 45_000;

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  apiKeyEnvName: "OPENAI_API_KEY",

  async chat(request: AiChatRequest, apiKey: string): Promise<AiChatResponse> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
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
          message: `OpenAI call exceeded the ${timeoutMs} ms time budget.`,
          retryable: true,
        });
      }
      throw new AiProviderError({
        code: "unknown",
        providerId: this.id,
        message: `Network failure while contacting OpenAI: ${err instanceof Error ? err.message : "unknown error"}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const code = codeFromStatus(this.id, response.status);

      // Refine 429: OpenAI uses it both for throttling and for exhausted
      // billing quota. Only the former is worth retrying.
      if (response.status === 429) {
        let errCode = "";
        try {
          errCode = JSON.parse(bodyText)?.error?.code ?? "";
        } catch {
          // non-JSON body — treat as generic rate limit
        }
        if (errCode === "insufficient_quota" || errCode === "credit_balance_exhausted") {
          throw new AiProviderError({
            code: "quota",
            providerId: this.id,
            message: "OpenAI credits are exhausted.",
            status: response.status,
          });
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new AiProviderError({
          code: "authentication",
          providerId: this.id,
          message: `OpenAI rejected the API key (HTTP ${response.status}).`,
          status: response.status,
        });
      }

      throw code;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: this.id,
        message: "OpenAI returned a non-JSON response body.",
        status: response.status,
      });
    }

    const record = data as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const text = record?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text) {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: this.id,
        message: "OpenAI response did not contain a usable completion.",
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
