// Recording helper for ACTIVE health checks (used by ai-health-check only).
// Same database path as passive recording but tagged source='health_check'
// and without a model id, since probes list models rather than call one.

import { supabaseAdminShared } from "./adminClient.ts";

export async function recordProviderOutcomeActive(args: {
  providerId: string;
  providerName: string;
  success: boolean;
  latencyMs?: number;
  httpStatus?: number;
  errorCode?: string;
}): Promise<void> {
  try {
    const { error } = await supabaseAdminShared.rpc("record_provider_outcome", {
      p_provider_id: args.providerId,
      p_provider_name: args.providerName,
      p_success: args.success,
      p_latency_ms: args.latencyMs ?? null,
      p_http_status: args.httpStatus ?? null,
      p_error_code: args.errorCode ?? null,
      p_model_id: null,
      p_source: "health_check",
    });
    if (error) {
      console.error(`Health-check recording failed for ${args.providerId}:`, error.message);
    }
  } catch (err) {
    console.error(
      `Health-check recording threw for ${args.providerId}:`,
      err instanceof Error ? err.message : "unknown error"
    );
  }
}
