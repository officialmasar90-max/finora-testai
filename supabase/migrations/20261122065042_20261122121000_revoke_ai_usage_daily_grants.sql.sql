/*
# Lock down ai_usage_daily table privileges (hardening follow-up)

1. Purpose
- The rate limiter table ai_usage_daily was created with default table
  grants for anon and authenticated. Row Level Security with zero policies
  already blocks all browser access, but the unused grants are surface area.
  Only the SECURITY DEFINER function consume_ai_usage (and service_role)
  should be able to touch quota state.

2. Changes
- REVOKE ALL on public.ai_usage_daily from anon and authenticated.
- Grants and privileges for postgres and service_role are unchanged.
- No data is modified.
*/

REVOKE ALL ON public.ai_usage_daily FROM anon, authenticated;
