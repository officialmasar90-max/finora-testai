// ─── Finora AI Hub — Provider Health Monitoring ────────────────
//
// Passive monitoring layer between the router and the provider registry.
// Every real provider attempt is recorded to the database (outcome, latency,
// error class, HTTP status — never keys, user data, or message content) and
// the circuit breaker state machine lives there too, so concurrent edge
// function instances share one consistent view.
//
// Design rules:
// - Monitoring NEVER breaks the chat flow: recording failures are logged
//   and swallowed, never thrown.
// - The circuit breaker only trips on retryable infrastructure failures
//   (timeout / server / rate_limit) after 3 consecutive occurrences.
//   Authentication and quota errors do not open the circuit (retrying
//   cannot help; the router skips those providers anyway via fallback).
// - HTTP 429 is treated as transient, never as permanent provider damage.

import { supabaseAdminShared } from "./adminClient.ts";
import { AiProviderError } from "./errors.ts";
import type { AiChatRequest, AiChatResponse } from "./types.ts";

export interface HealthSnapshot {
  providerId: string;
  circuitState: "closed" | "open" | "half_open";
  healthStatus: "healthy" | "degraded" | "unavailable" | "unknown";
}

const CIRCUIT_FAILURE_THRESHOLD = 3;

/** Whether this error class contributes to opening the circuit. */
function isBreakerRelevant(err: AiProviderError): boolean {
  return err.code === "timeout" || err.code === "server" || err.code === "rate_limit";
}

/**
 * Record a provider attempt. Passive only — all failures inside this
 * function are logged and ignored so monitoring can never break a chat.
 */
export async function recordProviderOutcome(args: {
  providerId: string;
  providerName: string;
  success: boolean;
  latencyMs?: number;
  httpStatus?: number;
  errorCode?: string;
  modelId?: string;
  source?: "chat" | "health_check";
}): Promise<void> {
  try {
    const { error } = await supabaseAdminShared.rpc("record_provider_outcome", {
      p_provider_id: args.providerId,
      p_provider_name: args.providerName,
      p_success: args.success,
      p_latency_ms: args.latencyMs ?? null,
      p_http_status: args.httpStatus ?? null,
      p_error_code: args.errorCode ?? null,
      p_model_id: args.modelId ?? null,
      p_source: args.source ?? "chat",
    });
    if (error) {
      console.error(`Health recording failed for ${args.providerId}:`, error.message);
    }
  } catch (err) {
    console.error(
      `Health recording threw for ${args.providerId}:`,
      err instanceof Error ? err.message : "unknown error"
    );
  }
}

/**
 * True when the provider's circuit allows a real user request right now.
 * A provider with an OPEN circuit is skipped; HALF_OPEN accepts at most one
 * probe request (acquired atomically in the database).
 */
export async function canProviderServe(providerId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdminShared.rpc("get_provider_health");
    if (error) {
      // Fail open on read errors: an unavailability of the monitoring layer
      // itself must not take every provider offline. Breaker logic on the
      // write path still holds, since outcomes keep being recorded.
      console.error("Health read failed (fail-open):", error.message);
      return true;
    }
    const row = (data ?? []).find((r: { provider_id: string }) => r.provider_id === providerId);
    if (!row) return true; // never attempted — allow

    if (row.circuit_state === "open") return false;
    if (row.circuit_state === "half_open") {
      // Single-flight probe: only one caller may pass per cooldown window.
      const { data: acquired, error: acquireError } = await supabaseAdminShared.rpc(
        "try_acquire_half_open_probe",
        { p_provider_id: providerId }
      );
      if (acquireError) {
        console.error(`Half-open acquire failed for ${providerId}:`, acquireError.message);
        return false;
      }
      return acquired === true;
    }
    return true;
  } catch (err) {
    console.error(
      `Health check threw for ${providerId} (fail-open):`,
      err instanceof Error ? err.message : "unknown error"
    );
    return true;
  }
}

export interface ChatWithMonitoringResult {
  response: AiChatResponse;
  errorCode: string | null;
  httpStatus: number | null;
}

/**
 * Execute one provider attempt with passive monitoring wrapped around it.
 * Rethrows the original AiProviderError after recording — never swallows
 * provider failures (the router owns fallback).
 */
export async function chatViaProviderWithMonitoring(
  request: AiChatRequest,
  providerName: string
): Promise<ChatWithMonitoringResult> {
  try {
    const response = await chatViaProvider(request);
    void recordProviderOutcome({
      providerId: request.providerId,
      providerName,
      success: true,
      latencyMs: response.latencyMs,
      modelId: request.model,
      source: "chat",
    });
    return { response, errorCode: null, httpStatus: null };
  } catch (err) {
    const providerError =
      err instanceof AiProviderError
        ? err
        : new AiProviderError({
            code: "unknown",
            providerId: request.providerId,
            message: err instanceof Error ? err.message : "unknown error",
          });
    void recordProviderOutcome({
      providerId: request.providerId,
      providerName,
      success: false,
      httpStatus: providerError.status,
      errorCode: providerError.code,
      modelId: request.model,
      source: "chat",
    });
    throw providerError;
  }
}

export { CIRCUIT_FAILURE_THRESHOLD };
