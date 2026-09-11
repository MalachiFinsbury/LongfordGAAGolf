import { afterEach, vi } from "vitest";

/**
 * Environment every server module expects to find. Individual tests override
 * or delete what they are exercising (see `withEnv` in helpers/env.ts); this
 * is only the baseline that keeps an import from throwing at module load.
 */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-for-tests",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  ADMIN_USERNAME: "organiser",
  ADMIN_PASSWORD: "correct-horse-battery",
  ADMIN_SESSION_SECRET: "test-secret-at-least-16-chars-long",
  NEXT_PUBLIC_SITE_URL: "https://golf.example.ie",
  ORGANISER_EMAILS: "one@club.ie, two@club.ie",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "Golf Classic <noreply@club.ie>",
};

for (const [key, value] of Object.entries(BASE_ENV)) {
  process.env[key] = value;
}

afterEach(() => {
  // Restore anything a test stubbed, then put the baseline back so a test that
  // deleted a variable cannot leak that into the next file.
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(BASE_ENV)) {
    process.env[key] = value;
  }
});
