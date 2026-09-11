import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/*
 * There is deliberately no anon-key client here any more.
 *
 * It existed so the registration form could INSERT under an RLS policy, but
 * NEXT_PUBLIC_SUPABASE_ANON_KEY is published to every browser that loads the
 * site — so any policy that key can satisfy describes what a stranger with
 * curl can do, not what the form can do. Every write now goes through the
 * service-role client below, inside a server action that has already
 * rate-limited, validated and clamped the input.
 *
 * If a browser-side Supabase client is ever genuinely needed, add it then, and
 * write the RLS policy on the assumption that the whole internet holds the key.
 */

/**
 * Admin client (service-role key). Bypasses RLS — server-only, never exposed
 * to the browser. Used by the admin dashboard to read all submissions.
 */
export function getAdminClient() {
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. See .env.example."
    );
  }
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}
