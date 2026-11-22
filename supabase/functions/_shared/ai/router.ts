// ─── Finora AI Hub — Automatic AI Intelligence Router ──────────
//
// The router decides which provider + model handles a user's question.
// Users never choose — Finora speaks with one voice; the router picks the
// intelligence behind it.
//
// Selection order for a task's candidate list:
//   1. Drop inactive models (registry `active: false`).
//   2. Drop providers without a registered adapter.
//   3. Drop providers whose API key secret is not configured.
//   4. Sort by priority (highest first).
//
// Execution with fallback: try candidates in order; on a retryable failure
// (timeout, throttling, 5xx, network) move to the next candidate after a
// bounded number of attempts; on a permanent failure (bad key, exhausted
// quota) skip the provider entirely. Never retries past MAX_TOTAL_ATTEMPTS,
// never leaks keys or raw provider errors.

import { getRegisteredProviderIds, hasProviderSecret, chatViaProvider } from "./providerRegistry.ts";
import { AiProviderError } from "./errors.ts";
import { DEFAULT_TASK, MODEL_REGISTRY } from "./modelRegistry.ts";
import type { AiTaskType, ModelEntry } from "./modelRegistry.ts";
import type { AiChatRequest, AiChatResponse } from "./types.ts";

const MAX_TOTAL_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1000;

export interface RouteDecision {
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface RouteResult extends AiChatResponse {
  /** Candidates that were tried and failed before success, for server logs. */
  fallbackTrail: string[];
}

/** Classify the user's question into a routing task type. */
export function classifyQuestion(message: string): AiTaskType {
  const text = message.toLowerCase();

  // Numeric / comparative analysis: debt payoff, budget splits, comparisons.
  const numericSignals = [
    "cicilan",
    "utang",
    "pinjaman",
    "anggaran",
    "budget",
    "hitung",
    "simulasi",
    "banding",
    "perbandingan",
    "snowball",
    "avalanche",
    "strategi pelunasan",
    "rasio",
    "bunga",
  ];
  if (numericSignals.some((s) => text.includes(s))) {
    return "numeric-analysis";
  }

  // Deep analysis: multi-part situations, "why", planning-heavy wording.
  const deepSignals = [
    "kenapa",
    "mengapa",
    "analisa",
    "analisis",
    "sehat",
    "kondisi keuangan",
    "rencana",
    "evaluasi",
    "penilaian",
    "atur",
    "susun",
    "menyeluruh",
    "kompleks",
  ];
  if (deepSignals.some((s) => text.includes(s))) {
    return "deep-analysis";
  }

  return DEFAULT_TASK;
}

/**
 * Ordered candidates for a task: configured, registered, active providers
 * only, highest priority first. Never throws — an empty list means the
 * caller reports the AI as unavailable.
 */
export function routeForTask(
  task: AiTaskType,
  secrets: Record<string, string | undefined>
): RouteDecision[] {
  const candidates = MODEL_REGISTRY[task] ?? [];
  const registered = getRegisteredProviderIds();

  return candidates
    .filter((m) => m.active)
    .filter((m) => registered.includes(m.providerId))
    .filter((m) => {
      const key = secrets[m.providerId];
      return typeof key === "string" && key.length > 0;
    })
    .sort((a, b) => b.priority - a.priority)
    .map((m) => ({
      providerId: m.providerId,
      modelId: m.modelId,
      displayName: m.displayName,
    }));
}

function toAiRequest(candidate: RouteDecision, base: Omit<AiChatRequest, "providerId" | "model">): AiChatRequest {
  return { ...base, providerId: candidate.providerId, model: candidate.modelId };
}

/**
 * Execute the chat request across the routed candidates with bounded
 * fallback. Throws the last AiProviderError if every attempt fails.
 */
export async function executeWithFallback(
  candidates: RouteDecision[],
  base: Omit<AiChatRequest, "providerId" | "model">
): Promise<RouteResult> {
  const failures: AiProviderError[] = [];
  const fallbackTrail: string[] = [];
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts >= MAX_TOTAL_ATTEMPTS) break;

    // One same-provider retry for transient errors, then move on.
    let lastError: AiProviderError | null = null;
    for (let inner = 0; inner < 2 && attempts < MAX_TOTAL_ATTEMPTS; inner++) {
      attempts++;
      try {
        const result = await chatViaProvider(toAiRequest(candidate, base));
        return { ...result, fallbackTrail };
      } catch (err) {
        const providerError =
          err instanceof AiProviderError
            ? err
            : new AiProviderError({
                code: "unknown",
                providerId: candidate.providerId,
                message: err instanceof Error ? err.message : "unknown error",
              });
        lastError = providerError;
        failures.push(providerError);

        // Permanent failure — do not retry this provider or wait.
        if (!providerError.retryable) break;

        if (inner === 0 && attempts < MAX_TOTAL_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    // Log the failure trail server-side (no keys, no raw bodies).
    if (lastError) {
      fallbackTrail.push(`${candidate.providerId}/${candidate.modelId}:${lastError.code}`);
      console.warn(
        `AI router: ${candidate.providerId}/${candidate.modelId} failed (${lastError.code}); falling back.`
      );
    }
  }

  const last = failures[failures.length - 1];
  throw (
    last ??
    new AiProviderError({
      code: "unknown",
      providerId: "router",
      message: "No AI provider is configured.",
    })
  );
}

/** Convenience: classify + route + execute in one call. */
export async function chatWithRouting(args: {
  message: string;
  secrets: Record<string, string | undefined>;
  messages: AiChatRequest["messages"];
  maxOutputTokens: number;
  temperature?: number;
}): Promise<RouteResult> {
  const task = classifyQuestion(args.message);
  const candidates = routeForTask(task, args.secrets);

  if (candidates.length === 0) {
    throw new AiProviderError({
      code: "authentication",
      providerId: "router",
      message: `No AI provider is configured for task "${task}".`,
    });
  }

  const result = await executeWithFallback(candidates, {
    messages: args.messages,
    maxOutputTokens: args.maxOutputTokens,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  });

  return result;
}
