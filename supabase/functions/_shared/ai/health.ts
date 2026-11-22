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
//   Authentication and quota errors never open the circuit (retrying
//   cannot help; the router already falls back on those).
// - Read failures fail open: an outage of the monitoring layer itself must
//   not take every provider offline — outcome recording still holds.

import { supabaseAdminShared } from "./adminClient.ts";
import { AiProviderError } from "./errors.ts";
import { chatViaProvider } from "./providerRegistry.ts";
import type { AiChatRequest, AiChatResponse } from "./types.ts";

const CIRCUIT_FAILURE_THRESHOLD = 3;

export interface ChatWithMonitoringResult {
  response: AiChatResponse;
}

/**
 * Execute one provider attempt with passive monitoring wrapped around it.
 * Rethrows the original AiProviderError after recording — never swallows
 * provider failures (the router owns fallback decisions).
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
    });
    return { response };
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
    });
    throw providerError;
  }
}

/** Passive recording — all failures are logged and swallowed. */
async function recordProviderOutcome(args: {
  providerId: string;
  providerName: string;
  success: boolean;
  latencyMs?: number;
  httpStatus?: number;
  errorCode?: string;
  modelId?: string;
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
      p_source: "chat",
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
 * OPEN → blocked; HALF_OPEN → at most one probe per cooldown window
 * (acquired atomically in the database, single-flight across instances).
 */
export async function canProviderServe(providerId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdminShared.rpc("get_provider_health");
    if (error) {
      console.error("Health read failed (fail-open):", error.message);
      return true;
    }
    const row = (data ?? []).find(
      (r: { provider_id: string }) => r.provider_id === providerId
    );
    if (!row) return true; // never attempted — allow

    if (row.circuit_state === "open") return false;
    if (row.circuit_state === "half_open") {
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

export { CIRCUIT_FAILURE_THRESHOLD };
