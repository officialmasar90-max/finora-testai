/*
# Atomic AI rate limiting: daily quota + per-minute burst limit

1. Purpose
- The AI consultant edge function enforced its 30-messages-per-day limit by
  counting `ai_messages` rows and then inserting — a count-then-act pattern.
  Concurrent requests all read the same count, so parallel calls could exceed
  the quota. This migration adds an atomic, database-enforced rate limiter
  that can never be raced, plus a per-minute burst limit to stop spam.

2. New Tables

### ai_usage_daily
- `user_id` (uuid, part of primary key; references auth.users on delete cascade)
- `usage_date` (date, part of primary key — UTC date the quota applies to)
- `message_count` (integer, not null, default 0 — requests consumed that day)
- `burst_count` (integer, not null, default 0 — requests in the current burst window)
- `burst_window_start` (timestamptz, nullable — when the current 60s window began)
- `created_at` / `updated_at` (timestamptz)

Primary key (`user_id`, `usage_date`) makes the upsert race-free: concurrent
requests for the same user and day always hit the same row, serialized by the
row lock taken inside the function.

3. New Functions

### consume_ai_usage(p_user_id uuid, p_daily_limit integer, p_burst_limit integer)
RETURNS TABLE(allowed boolean, reason text, daily_used integer, daily_remaining integer, retry_after_seconds integer)
- SECURITY DEFINER so it can manage quota state without granting the
  underlying table to any caller.
- Runs in a single transaction with a row lock taken by the upsert, so two
  concurrent requests can never both consume the last remaining message:
  1. Daily check: rejects when `message_count` for the current UTC day has
     reached `p_daily_limit`. `retry_after_seconds` is the time until UTC
     midnight.
  2. Burst check: fixed 60-second window per user. If the window is fresh the
     request starts it; otherwise the request is rejected once
     `burst_count` has reached `p_burst_limit`. `retry_after_seconds` is the
     time until the window expires.
  3. If both pass, increments `message_count` and the burst counter in the
     same locked statement.
- The server (edge function) passes the limits; the browser can never
  influence them.
- All time comes from the database clock in UTC, so the user's device clock
  is irrelevant.

4. Security
- RLS enabled on `ai_usage_daily` with NO policies: no browser role (anon or
  authenticated) can read or write quota state, so users cannot reset or
  inflate their own quota.
- REVOKE EXECUTE on the function FROM PUBLIC and anon.
- GRANT EXECUTE only to `service_role` — the edge function calls it after
  verifying the caller's JWT itself, so `p_user_id` always comes from a
  verified session, never from the browser.

5. Data Safety
- No existing data is modified. Historical usage remains untouched in
  `ai_messages`.
*/

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  burst_count integer NOT NULL DEFAULT 0 CHECK (burst_count >= 0),
  burst_window_start timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_date)
);

ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_ai_usage(
  p_user_id uuid,
  p_daily_limit integer,
  p_burst_limit integer
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  daily_used integer,
  daily_remaining integer,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_now timestamptz := now();
  v_daily_count integer;
  v_burst_count integer;
  v_window_start timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_daily_limit IS NULL OR p_burst_limit IS NULL
     OR p_daily_limit < 1 OR p_burst_limit < 1 THEN
    RAISE EXCEPTION 'consume_ai_usage: invalid arguments';
  END IF;

  -- Insert today's row or lock the existing one. The row lock (held until
  -- this transaction ends) serializes concurrent requests from the same user.
  INSERT INTO ai_usage_daily (user_id, usage_date)
  VALUES (p_user_id, v_today)
  ON CONFLICT (user_id, usage_date)
  DO UPDATE SET updated_at = now()
  RETURNING message_count, burst_count, burst_window_start
  INTO v_daily_count, v_burst_count, v_window_start;

  -- ── Daily quota check (UTC day, database clock) ──
  IF v_daily_count >= p_daily_limit THEN
    RETURN QUERY SELECT
      FALSE,
      'DAILY_LIMIT_REACHED'::text,
      v_daily_count,
      0,
      CEILING(EXTRACT(EPOCH FROM (
        (v_today + interval '1 day')::timestamp - (v_now AT TIME ZONE 'UTC')
      )))::integer;
    RETURN;
  END IF;

  -- ── Burst check: fixed 60-second window per user ──
  IF v_window_start IS NOT NULL
     AND v_now - v_window_start < interval '60 seconds'
     AND v_burst_count >= p_burst_limit THEN
    RETURN QUERY SELECT
      FALSE,
      'BURST_LIMIT_REACHED'::text,
      v_daily_count,
      p_daily_limit - v_daily_count,
      CEILING(60 - EXTRACT(EPOCH FROM (v_now - v_window_start)))::integer;
    RETURN;
  END IF;

  -- ── Allowed: consume one message atomically ──
  IF v_window_start IS NULL OR v_now - v_window_start >= interval '60 seconds' THEN
    UPDATE ai_usage_daily
    SET message_count = message_count + 1,
        burst_count = 1,
        burst_window_start = v_now,
        updated_at = v_now
    WHERE user_id = p_user_id AND usage_date = v_today;
  ELSE
    UPDATE ai_usage_daily
    SET message_count = message_count + 1,
        burst_count = burst_count + 1,
        updated_at = v_now
    WHERE user_id = p_user_id AND usage_date = v_today;
  END IF;

  RETURN QUERY SELECT
    TRUE,
    NULL::text,
    v_daily_count + 1,
    p_daily_limit - v_daily_count - 1,
    0;
END;
$$;

-- Only the edge function (service_role) may call this function. No browser
-- role can execute it, read it, or touch the underlying table.
REVOKE EXECUTE ON FUNCTION public.consume_ai_usage(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_usage(uuid, integer, integer) TO service_role;
