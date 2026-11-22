/*
# Fix record_provider_outcome NULL flag handling

1. Purpose
- When a provider attempt succeeds, p_error_code is NULL. The expressions
  `p_error_code IN ('rate_limit','quota')` and `p_error_code = 'authentication'`
  then evaluate to NULL, violating the NOT NULL constraints on quota_flag and
  auth_flag and aborting the recording.

2. Changes
- CREATE OR REPLACE record_provider_outcome with COALESCE(..., false) around
  both flag expressions. Logic otherwise unchanged.

3. Security
- Grants and revokes re-asserted identically (idempotent re-run).
*/

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
      quota_flag = COALESCE(p_error_code IN ('rate_limit', 'quota'), false),
      auth_flag = COALESCE(p_error_code = 'authentication', false),
      circuit_state = v_circuit_state,
      circuit_opened_at = CASE WHEN v_just_opened THEN now() ELSE circuit_opened_at END,
      half_open_attempts = 0,
      model_id = COALESCE(p_model_id, model_id),
      updated_at = now()
  WHERE provider_id = p_provider_id;

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

REVOKE EXECUTE ON FUNCTION public.record_provider_outcome(text, text, boolean, integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_outcome(text, text, boolean, integer, integer, text, text, text) TO service_role;
