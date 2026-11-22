// ─── Finora AI Hub — Google Gemini Provider Adapter ────────────
//
// Gemini uses its own wire format (generateContent) instead of the OpenAI
// chat completions shape. This adapter translates the standard Finora
// contract to Gemini and back. The API key is sent via the x-goog-api-key
// header — never in the URL, never logged.

import type { ProviderAdapter } from "../providerAdapter.ts";
import { AiProviderError, codeFromStatus } from "../errors.ts";
import type { AiChatRequest, AiChatResponse } from "../types.ts";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 45_000;

// Gemini has no "system" role on all versions; system content is passed as a
// top-level systemInstruction field. Roles are also spelled differently.
interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  displayName: "Google Gemini",
  apiKeyEnvName: "GEMINI_API_KEY",

  async chat(request: AiChatRequest, apiKey: string): Promise<AiChatResponse> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];
    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
        continue;
      }
      const last = contents[contents.length - 1];
      const role = msg.role === "assistant" ? "model" : "user";
      if (last && last.role === role) {
        last.parts.push({ text: msg.content });
      } else {
        contents.push({ role, parts: [{ text: msg.content }] });
      }
    }

    let response: Response;
    try {
      response = await fetch(
        `${GEMINI_BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents,
            ...(systemParts.length > 0
              ? { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } }
              : {}),
            generationConfig: {
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.maxOutputTokens !== undefined
                ? { maxOutputTokens: request.maxOutputTokens }
                : {}),
            },
          }),
          signal: controller.signal,
        }
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiProviderError({
          code: "timeout",
          providerId: this.id,
          message: `Gemini call exceeded the ${timeoutMs} ms time budget.`,
          retryable: true,
        });
      }
      throw new AiProviderError({
        code: "unknown",
        providerId: this.id,
        message: `Network failure while contacting Gemini: ${err instanceof Error ? err.message : "unknown error"}`,
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
        message: "Gemini returned a non-JSON response body.",
        status: response.status,
      });
    }

    const record = data as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };

    const candidate = record?.candidates?.[0];
    const text = candidate?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new AiProviderError({
        code: "invalid_response",
        providerId: this.id,
        message: `Gemini response did not contain a usable completion (finishReason: ${candidate?.finishReason ?? "unknown"}).`,
        status: response.status,
      });
    }

    return {
      text,
      usage: {
        promptTokens: record.usageMetadata?.promptTokenCount,
        completionTokens: record.usageMetadata?.candidatesTokenCount,
        totalTokens: record.usageMetadata?.totalTokenCount,
      },
      providerId: this.id,
      model: request.model,
      latencyMs,
    };
  },
};
