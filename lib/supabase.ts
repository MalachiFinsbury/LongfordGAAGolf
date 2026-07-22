import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Public client (anon key). Used server-side to INSERT form submissions.
 * RLS allows inserts only; it cannot read the data back.
 */
export function getPublicClient() {
  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example."
    );
  }
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });
}

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
