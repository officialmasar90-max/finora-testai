/*
# Revoke unused anon grants on app tables

1. Purpose
- All 8 public tables (transactions, budgets, debts, goals, financial_assessments,
  ai_conversations, ai_messages, profiles) granted SELECT/INSERT/UPDATE/DELETE to
  both `anon` and `authenticated`, but every RLS policy targets `authenticated`
  only. The `anon` grants are unused surface area.

2. Changes
- Revoke all privileges from `anon` on the 8 tables. `authenticated` grants and
  all RLS policies are unchanged. No data is modified.

3. Notes
- The app always signs users in before querying these tables, and the AI edge
  function uses `service_role`, so nothing in the app relies on anon access.
*/

REVOKE ALL ON transactions FROM anon;
REVOKE ALL ON budgets FROM anon;
REVOKE ALL ON debts FROM anon;
REVOKE ALL ON goals FROM anon;
REVOKE ALL ON financial_assessments FROM anon;
REVOKE ALL ON ai_conversations FROM anon;
REVOKE ALL ON ai_messages FROM anon;
REVOKE ALL ON profiles FROM anon;
