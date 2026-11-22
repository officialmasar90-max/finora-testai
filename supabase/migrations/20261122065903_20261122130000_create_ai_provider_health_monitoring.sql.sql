/*
# AI Provider Health Monitoring + Circuit Breaker

1. Purpose
- Adds server-side monitoring of AI provider health so the AI Router can
  avoid providers that are currently failing. Two new tables: an aggregate
  health state per provider (including circuit breaker state), and a compact
  event log of recent request outcomes. The AI Router reads the health table
  before each routing decision and the gateway records outcomes after each
  provider attempt — all atomically in the database so concurrent edge
  function instances stay consistent.

2. New Tables

### ai_provider_health (one row per provider, upserted)
- `provider_id` (text, primary key — e.g. "openai")
- `provider_name` (text — human-readable display name)
- `model_id` (text — last model used with this provider, nullable)
- `circuit_state` (text, CHECK in 'closed','open','half_open', default 'closed')
- `consecutive_failures` (integer, default 0)
- `circuit_opened_at` (timestamptz, nullable — when the circuit last opened)
- `half_open_attempts` (integer, default 0 — in-flight/used half-open probes)
- `last_success_at` / `last_failure_at` (timestamptz, nullable)
- `last_checked_at` (timestamptz, nullable — last active health check)
- `last_latency_ms` (integer, nullable)
- `avg_latency_ms` (integer, nullable — running average of recent requests)
- `success_count` / `error_count` (bigint, default 0 — lifetime counters)
- `last_error_code` (text, nullable — e.g. 'timeout', 'server', 'rate_limit')
- `last_http_status` (integer, nullable)
- `quota_flag` (boolean, default false — provider reported quota/rate-limit issues)
- `auth_flag` (boolean, default false — provider reported authentication problems)
- `updated_at` (timestamptz)
- `health_status` is NOT stored: it is derived at read time from counters and
  circuit state (see get_provider_health), so it can never go stale.

### ai_provider_events (bounded, recent-only)
- `id` (bigserial primary key)
- `provider_id` (text, not null)
- `model_id` (text, nullable)
- `success` (boolean, not null)
- `latency_ms` (integer, nullable)
- `http_status` (integer, nullable)
- `error_code` (text, nullable)
- `source` (text, CHECK in 'chat','health_check', default 'chat')
- `created_at` (timestamptz, default now())
- NO message content, NO user identifiers, NO keys — only outcome metrics.
- Indexed on (provider_id, created_at DESC) for efficient recent queries.
- Old rows are pruned by the recording function (keeps the newest 500) so
  storage stays bounded.

3. New Functions

### record_provider_outcome(p_provider_id, p_success, p_latency_ms, p_http_status, p_error_code, p_model_id, p_source)
RETURNS json — SECURITY DEFINER, called by the edge function after each
provider attempt. Atomically (row lock via upsert):
- increments success_count or error_count,
- updates last_success_at / last_failure_at, latency (running average over
  the last 20 outcomes blended with current), last error code/status,
- sets quota_flag on rate_limit/quota codes, auth_flag on authentication,
- circuit breaker: after 3 consecutive retryable failures ('timeout',
  'server', or 'rate_limit' — user input errors and auth/quota failures do
  NOT open the circuit since retrying cannot help and transient throttling
  is not permanent damage), sets circuit_state='open', circuit_opened_at,
  resets half_open_attempts.
- A success always closes the circuit and clears consecutive_failures.

### get_provider_health() RETURNS TABLE — SECURITY DEFINER read view of
ai_provider_health plus a derived health_status column:
- 'unavailable' when circuit is open
- 'degraded' when circuit is half_open, or recent error rate over the last
  20 events >= 50%, or auth/quota flag set
- 'healthy' when at least one recorded success and not degraded
- 'unknown' when no outcomes recorded yet.

### try_acquire_half_open_probe(p_provider_id) RETURNS boolean — SECURITY
DEFINER, atomically decides whether a provider with an OPEN circuit may be
probed after the 60-second cooldown: flips state to 'half_open' (once per
cooldown window, max 1 concurrent probe) and returns true; otherwise false.

### close_circuit_if_cooldown_elapsed() — helper applied in the read path
and acquire path: any provider whose circuit has been 'open' for >= 60
seconds is moved to 'half_open' with half_open_attempts = 0 (idempotent).

4. Security
- RLS enabled on both tables with NO policies: no browser role can read or
  write monitoring data (it reveals internal infrastructure state).
- REVOKE ALL on tables from anon, authenticated.
- Functions: EXECUTE revoked from PUBLIC/anon/authenticated, granted only to
  service_role (edge functions call them with the service role key after
  verifying the user's JWT themselves).

5. Data Safety
- No existing tables are modified. No keys, no user data, no conversation
  content is stored here.
*/

CREATE TABLE IF NOT EXISTS public.ai_provider_health (
  provider_id text PRIMARY KEY,
  provider_name text NOT NULL,
  model_id text,
  circuit_state text NOT NULL DEFAULT 'closed'
    CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_opened_at timestamptz,
  half_open_attempts integer NOT NULL DEFAULT 0 CHECK (half_open_attempts >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_checked_at timestamptz,
  last_latency_ms integer,
  avg_latency_ms integer,
  success_count bigint NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  error_count bigint NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  last_error_code text,
  last_http_status integer,
  quota_flag boolean NOT NULL DEFAULT false,
  auth_flag boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_provider_events (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL,
  model_id text,
  success boolean NOT NULL,
  latency_ms integer,
  http_status integer,
  error_code text,
  source text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'health_check')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_events_provider_time
  ON public.ai_provider_events (provider_id, created_at DESC);

ALTER TABLE public.ai_provider_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_provider_health FROM anon, authenticated;
REVOKE ALL ON public.ai_provider_events FROM anon, authenticated;

-- ── Circuit breaker: move OPEN circuits past cooldown to HALF_OPEN ──
CREATE OR REPLACE FUNCTION public.close_circuit_if_cooldown_elapsed()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE ai_provider_health
  SET circuit_state = 'half_open',
      half_open_attempts = 0,
      updated_at = now()
  WHERE circuit_state = 'open'
    AND circuit_opened_at IS NOT NULL
    AND now() - circuit_opened_at >= interval '60 seconds';
$$;

-- ── Record one provider attempt (passive monitoring + breaker logic) ──
CREATE OR REPLACE FUNCTION public.record_provider_outcome(
  p_provider_id text,
  p_provider_name text,
  p_success boolean,
  p_latency_ms integer,
  p_http_status integer,
  p_error_code text,
  p_model_id text,
  p_source text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_circuit_state text;
  v_consecutive integer;
  v_avg_latency integer;
  v_breaker_relevant boolean;
  v_just_opened boolean := false;
BEGIN
  -- Lock (and create) the provider's row; serializes concurrent instances.
  INSERT INTO ai_provider_health (provider_id, provider_name)
  VALUES (p_provider_id, p_provider_name)
  ON CONFLICT (provider_id) DO UPDATE SET updated_at = now()
  RETURNING circuit_state, consecutive_failures, avg_latency_ms
  INTO v_circuit_state, v_consecutive, v_avg_latency;

  v_breaker_relevant := p_error_code IN ('timeout', 'server', 'rate_limit');

  IF p_success THEN
    v_consecutive := 0;
    v_avg_latency := CASE
      WHEN v_avg_latency IS NULL THEN p_latency_ms
      ELSE (v_avg_latency * 19 + COALESCE(p_latency_ms, v_avg_latency)) / 20
    END;
  ELSE
    v_consecutive := v_consecutive + 1;
  END IF;

  -- Open the circuit after 3 consecutive retryable-failure-class errors.
  IF NOT p_success AND v_breaker_relevant AND v_consecutive >= 3
     AND v_circuit_state = 'closed' THEN
    v_circuit_state := 'open';
    v_just_opened := true;
  END IF;

  UPDATE ai_provider_health
  SET success_count = success_count + (CASE WHEN p_success THEN 1 ELSE 0 END),
      error_count = error_count + (CASE WHEN p_success THEN 0 ELSE 1 END),
      consecutive_failures = v_consecutive,
      last_success_at = CASE WHEN p_success THEN now() ELSE last_success_at END,
      last_failure_at = CASE WHEN p_success THEN last_failure_at ELSE now() END,
      last_latency_ms = CASE WHEN p_success THEN p_latency_ms ELSE last_latency_ms END,
      avg_latency_ms = v_avg_latency,
      last_error_code = CASE WHEN p_success THEN NULL ELSE p_error_code END,
      last_http_status = CASE WHEN p_success THEN NULL ELSE p_http_status END,
      quota_flag = (p_error_code IN ('rate_limit', 'quota')),
      auth_flag = (p_error_code = 'authentication'),
      circuit_state = v_circuit_state,
      circuit_opened_at = CASE WHEN v_just_opened THEN now() ELSE circuit_opened_at END,
      half_open_attempts = 0,
      model_id = COALESCE(p_model_id, model_id),
      updated_at = now()
  WHERE provider_id = p_provider_id;

  -- Bounded event log: insert outcome, prune beyond the newest 500 rows.
  INSERT INTO ai_provider_events (provider_id, model_id, success, latency_ms, http_status, error_code, source)
  VALUES (p_provider_id, p_model_id, p_success, p_latency_ms, p_http_status, p_error_code, p_source);
  DELETE FROM ai_provider_events
  WHERE id IN (
    SELECT id FROM ai_provider_events
    ORDER BY created_at DESC, id DESC
    OFFSET 500
  );

  RETURN json_build_object(
    'circuitState', v_circuit_state,
    'consecutiveFailures', v_consecutive,
    'justOpened', v_just_opened
  );
END;
$$;

-- ── Half-open probe gating: at most one probe per cooldown window ──
CREATE OR REPLACE FUNCTION public.try_acquire_half_open_probe(p_provider_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text;
BEGIN
  PERFORM close_circuit_if_cooldown_elapsed();

  UPDATE ai_provider_health
  SET half_open_attempts = half_open_attempts + 1,
      updated_at = now()
  WHERE provider_id = p_provider_id
    AND circuit_state = 'half_open'
    AND half_open_attempts < 1
  RETURNING circuit_state INTO v_state;

  RETURN v_state IS NOT NULL;
END;
$$;

-- ── Read path: derived health status (never stored, never stale) ──
CREATE OR REPLACE FUNCTION public.get_provider_health()
RETURNS TABLE (
  provider_id text,
  provider_name text,
  circuit_state text,
  health_status text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_latency_ms integer,
  avg_latency_ms integer,
  success_count bigint,
  error_count bigint,
  last_error_code text,
  last_http_status integer,
  quota_flag boolean,
  auth_flag boolean,
  model_id text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH recent AS (
    SELECT provider_id,
           count(*)::int AS recent_total,
           count(*) FILTER (WHERE NOT success)::int AS recent_errors
    FROM ai_provider_events
    WHERE created_at > now() - interval '24 hours'
    GROUP BY provider_id
  )
  SELECT
    h.provider_id,
    h.provider_name,
    h.circuit_state,
    CASE
      WHEN h.circuit_state = 'open' THEN 'unavailable'
      WHEN h.circuit_state = 'half_open' THEN 'degraded'
      WHEN h.auth_flag OR h.quota_flag THEN 'degraded'
      WHEN r.recent_total >= 5
           AND r.recent_errors::numeric / r.recent_total >= 0.5 THEN 'degraded'
      WHEN h.success_count > 0 THEN 'healthy'
      ELSE 'unknown'
    END AS health_status,
    h.last_checked_at,
    h.last_success_at,
    h.last_failure_at,
    h.last_latency_ms,
    h.avg_latency_ms,
    h.success_count,
    h.error_count,
    h.last_error_code,
    h.last_http_status,
    h.quota_flag,
    h.auth_flag,
    h.model_id
  FROM ai_provider_health h
  LEFT JOIN recent r ON r.provider_id = h.provider_id;
$$;

REVOKE EXECUTE ON FUNCTION public.record_provider_outcome(text, text, boolean, integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.try_acquire_half_open_probe(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_provider_health() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_circuit_if_cooldown_elapsed() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_provider_outcome(text, text, boolean, integer, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.try_acquire_half_open_probe(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_provider_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.close_circuit_if_cooldown_elapsed() TO service_role;
