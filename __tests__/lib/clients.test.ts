/**
 * The two client factories.
 *
 * Neither does much, and that is the point: each is a guard that decides
 * whether the app runs at all with the configuration it has been given. Both
 * must fail loudly rather than hand back something half-built, and the Supabase
 * one must no longer offer a client built on the key that ships to browsers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/supabase.ts reads its environment once, at module load. Re-importing
 * under a stubbed environment is the only way to exercise the missing-config
 * branches.
 */
async function importSupabaseWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("@/lib/supabase");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the Supabase admin client", () => {
  it("is returned when the service-role key is configured", async () => {
    const { getAdminClient } = await import("@/lib/supabase");
    const client = getAdminClient();

    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
    expect(typeof client.rpc).toBe("function");
  });

  it("refuses to run without the service-role key, naming the file to look in", async () => {
    const { getAdminClient } = await importSupabaseWith({
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });
    expect(() => getAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => getAdminClient()).toThrow(/\.env\.example/);
  });

  it("refuses to run without the project URL", async () => {
    const { getAdminClient } = await importSupabaseWith({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
    });
    expect(() => getAdminClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("no longer offers a client built on the browser-published anon key", async () => {
    // That key is served to everyone who loads the site, so any RLS policy it
    // can satisfy describes what a stranger with curl can do — not what the
    // registration form can do. Every write now goes through the service-role
    // client inside a server action that has already validated and clamped it.
    const supabase = await import("@/lib/supabase");
    expect("getPublicClient" in supabase).toBe(false);
  });

  it("does not persist a session, since there is no browser to persist one for", async () => {
    const { getAdminClient } = await import("@/lib/supabase");
    // Two calls hand back independent clients rather than sharing auth state.
    expect(getAdminClient()).not.toBe(getAdminClient());
  });
});

describe("the Stripe client", () => {
  it("is returned when the secret key is configured", async () => {
    const { getStripe } = await import("@/lib/stripe");
    expect(typeof getStripe().checkout.sessions.create).toBe("function");
  });

  it("refuses to run without a secret key", async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { getStripe } = await import("@/lib/stripe");

    expect(() => getStripe()).toThrow(/Missing STRIPE_SECRET_KEY/);
  });

  it("reuses one client rather than building a new one per request", async () => {
    const { getStripe } = await import("@/lib/stripe");
    expect(getStripe()).toBe(getStripe());
  });

  it("pins the API version the SDK was generated against", async () => {
    // Otherwise a Stripe-side upgrade could silently change response shapes
    // under code that reads them field by field.
    const { getStripe } = await import("@/lib/stripe");
    const client = getStripe() as unknown as {
      _api: { version: string };
    };

    expect(client._api.version).toBe("2026-06-24.dahlia");
  });

  it("identifies the integration to Stripe", async () => {
    const { getStripe } = await import("@/lib/stripe");
    const client = getStripe() as unknown as {
      _appInfo?: { name: string };
    };

    expect(client._appInfo?.name).toBe("Longford GAA Golf Classic");
  });
});
