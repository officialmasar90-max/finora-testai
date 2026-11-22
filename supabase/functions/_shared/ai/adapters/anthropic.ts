// ─── Finora AI Hub — Anthropic Claude Provider Adapter ─────────
//
// Claude's Messages API has its own wire format: system content is a
// top-level field, roles are "user"/"assistant", and the API version header
// is mandatory. This adapter translates the standard Finora contract.

import type { ProviderAdapter } from "../providerAdapter.ts";
import { AiProviderError, codeFromStatus } from "../errors.ts";
import type { AiChatRequest, AiChatResponse } from "../types.ts";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const API_VERSION = "2023-06-01";

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  displayName: "Anthropic Claude",
  apiKeyEnvName: "ANTHROPIC_API_KEY",

  async chat(request: AiChatRequest, apiKey: string): Promise<AiChatResponse> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    const systemParts: string[] = [];
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
        continue;
      }
      messages.push({ role: msg.role, content: msg.content });
    }

    let response: Response;
    try {
      response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens ?? 1024,
          messages,
          ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiProviderError({
          code: "timeout",
          providerId: this.id,
          message: `Anthropic call exceeded the ${timeoutMs} ms time budget.`,
          retryable: true,
        });
      }
      throw new AiProviderError({
        code: "unknown",
        providerId: this.id,
        message: `Network failure while contacting Anthropic: ${err instanceof Error ? err.message : "unknown error"}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      // Anthropic signals exhausted credits / invalid keys with the same
      // status codes as OpenAI; codeFromStatus maps them correctly.
      throw codeFromStatus(this.id, response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: this.id,
        message: "Anthropic returned a non-JSON response body.",
        status: response.status,
      });
    }

    const record = data as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (record?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: this.id,
        message: "Anthropic response did not contain a usable completion.",
        status: response.status,
      });
    }

    return {
      text,
      usage: {
        promptTokens: record.usage?.input_tokens,
        completionTokens: record.usage?.output_tokens,
        totalTokens:
          record.usage?.input_tokens !== undefined && record.usage?.output_tokens !== undefined
            ? record.usage.input_tokens + record.usage.output_tokens
            : undefined,
      },
      providerId: this.id,
      model: request.model,
      latencyMs,
    };
  },
};
