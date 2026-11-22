// ─── Finora AI Health Check — Scheduled Active Probes ──────────
//
// Cost-aware active health checks: for each configured provider, calls the
// provider's OFFICIAL free model-listing endpoint (no token generation, no
// billing impact) to verify the API key works and the API is reachable.
// Never sends conversation content, never consumes generation quota.
//
// Requires each adapter to expose a `probe()` that returns:
//   ok: boolean, latencyMs: number, httpStatus: number, modelIds?: string[],
//   errorCode?: string
//
// Outcomes are recorded through the same record_provider_outcome RPC the
// passive path uses, so active checks and real traffic feed one consistent
// health state and circuit breaker. Intended to run on a schedule (e.g.
// hourly via Supabase cron/scheduler — see config note below); it is safe
// to call more often, since probes are free, but rate-limits itself per
// provider to at most one probe per 10 minutes.

import { getRegisteredProviderIds, hasProviderSecret, getAdapterProbe } from "./_shared/ai/providerRegistry.ts";
import { recordProviderOutcome } from "./_shared/ai/health.ts";
import { supabaseAdminShared } from "./_shared/ai/adminClient.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MIN_PROBE_INTERVAL_MS = 10 * 60 * 1000; // one probe per provider / 10 min

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // Refresh breaker cooldowns (OPEN -> HALF_OPEN after 60s).
    await supabaseAdminShared.rpc("close_circuit_if_cooldown_elapsed");

    const { data: healthRows, error: healthError } = await supabaseAdminShared.rpc("get_provider_health");
    if (healthError) {
      console.error("Health snapshot read failed:", healthError.message);
      return new Response(
        JSON.stringify({ error: "Gagal membaca status provider" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: {
      providerId: string;
      probed: boolean;
      ok?: boolean;
      latencyMs?: number;
      httpStatus?: number;
      errorCode?: string | null;
    }[] = [];

    for (const providerId of getRegisteredProviderIds()) {
      if (!hasProviderSecret(providerId)) {
        results.push({ providerId, probed: false });
        continue;
      }

      const row = (healthRows ?? []).find(
        (r: { provider_id: string }) => r.provider_id === providerId
      );
      const lastSuccess = row?.last_success_at ? new Date(row.last_success_at).getTime() : 0;
      const now = Date.now();
      if (now - lastSuccess < MIN_PROBE_INTERVAL_MS) {
        // Healthy recently via real traffic — skip the probe (cost discipline).
        results.push({ providerId, probed: false });
        continue;
      }

      const probe = getAdapterProbe(providerId);
      if (!probe) {
        results.push({ providerId, probed: false });
        continue;
      }

      const outcome = await probe();
      await recordProviderOutcome({
        providerId,
        providerName: providerId,
        success: outcome.ok,
        latencyMs: outcome.latencyMs,
        httpStatus: outcome.httpStatus,
        errorCode: outcome.errorCode ?? undefined,
        source: "health_check",
      });
      await supabaseAdminShared.rpc("close_circuit_if_cooldown_elapsed");
      results.push({
        providerId,
        probed: true,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        httpStatus: outcome.httpStatus,
        errorCode: outcome.errorCode ?? null,
      });
    }

    return new Response(
      JSON.stringify({ checked: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(
      "Health check function error:",
      err instanceof Error ? err.message : "unknown error"
    );
    return new Response(
      JSON.stringify({ error: "Terjadi kesalahan sistem. Silakan coba lagi." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
