// ─── Finora AI Hub — Service Role Admin Client ─────────────────
//
// One shared service-role Supabase client for server-side infrastructure
// concerns (health monitoring, rate limiting). Service role bypasses RLS —
// it must NEVER be imported by anything reachable from the browser.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

let cached: ReturnType<typeof createClient> | null = null;

function getAdmin(): ReturnType<typeof createClient> {
  if (!cached) {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    cached = createClient(url, key, { auth: { persistSession: false } });
  }
  return cached;
}

// Lazily forwarding proxy so importing this module never touches env vars
// until the first actual database call.
export const supabaseAdminShared = new Proxy(
  {} as ReturnType<typeof createClient>,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getAdmin(), prop, receiver);
    },
  }
);
