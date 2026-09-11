import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../helpers/supabase";
import { fakeHeaders } from "../helpers/next";

const db = new FakeSupabase();
let requestHeaders: Record<string, string> = {};
/** Set by the test that checks what happens outside a request scope. */
let headersFail: Error | null = null;

vi.mock("next/headers", () => ({
  headers: async () => {
    if (headersFail) throw headersFail;
    return fakeHeaders(requestHeaders);
  },
}));

vi.mock("@/lib/supabase", () => ({
  getAdminClient: () => db,
  getPublicClient: () => db,
}));

const { checkRateLimit } = await import("@/lib/rate-limit");

/** Counts calls the way the real `bump_rate_limit` function does. */
function countingRpc() {
  const counters = new Map<string, number>();
  db.onRpc("bump_rate_limit", (args) => {
    const key = String(args.p_key);
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return { data: next, error: null };
  });
  return counters;
}

beforeEach(() => {
  db.reset();
  requestHeaders = { "x-forwarded-for": "203.0.113.7" };
  headersFail = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("checkRateLimit", () => {
  it("allows the first attempt and reports the running count", async () => {
    countingRpc();
    expect(await checkRateLimit("registration")).toEqual({ allowed: true, count: 1 });
  });

  it("allows attempts up to the limit and blocks the one past it", async () => {
    countingRpc();
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await checkRateLimit("registration"));

    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[10].allowed).toBe(false);
    expect(results[11].allowed).toBe(false);
    expect(results[10].count).toBe(11);
  });

  it("counts each scope in its own bucket", async () => {
    // Ten failed logins must not lock the public registration form, and vice
    // versa — a whole clubhouse shares one address.
    countingRpc();
    for (let i = 0; i < 11; i++) await checkRateLimit("admin-login");

    expect((await checkRateLimit("admin-login")).allowed).toBe(false);
    expect((await checkRateLimit("registration")).allowed).toBe(true);
  });

  it("counts each client address in its own bucket", async () => {
    countingRpc();
    for (let i = 0; i < 11; i++) await checkRateLimit("registration");
    expect((await checkRateLimit("registration")).allowed).toBe(false);

    requestHeaders = { "x-forwarded-for": "198.51.100.4" };
    expect((await checkRateLimit("registration")).allowed).toBe(true);
  });

  it("keys on the left-most forwarded address, which the platform sets", async () => {
    // A spoofed value gets appended after the real client, so taking the first
    // entry is what stops a caller choosing their own bucket.
    countingRpc();
    requestHeaders = { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 172.16.0.9" };
    await checkRateLimit("registration");
    expect(db.rpcCalls[0].args.p_key).toBe("registration:203.0.113.7");
  });

  it("trims whitespace around the forwarded address", async () => {
    countingRpc();
    requestHeaders = { "x-forwarded-for": "  203.0.113.7  , 10.0.0.1" };
    await checkRateLimit("registration");
    expect(db.rpcCalls[0].args.p_key).toBe("registration:203.0.113.7");
  });

  it("falls back to x-real-ip when there is no forwarded header", async () => {
    countingRpc();
    requestHeaders = { "x-real-ip": "192.0.2.55" };
    await checkRateLimit("registration");
    expect(db.rpcCalls[0].args.p_key).toBe("registration:192.0.2.55");
  });

  it("buckets an unidentifiable caller together rather than exempting them", async () => {
    countingRpc();
    requestHeaders = {};
    await checkRateLimit("registration");
    expect(db.rpcCalls[0].args.p_key).toBe("registration:unknown");
  });

  it("passes the window length the SQL function expects", async () => {
    countingRpc();
    await checkRateLimit("registration");
    expect(db.rpcCalls[0].args.p_window_seconds).toBe(3600);
  });

  it("fails open when the counter itself errors", async () => {
    // Deliberate trade for the public form: the limiter stops bulk abuse, it is
    // not a security boundary, and losing a genuine fundraising entry is the
    // worse outcome.
    db.onRpc("bump_rate_limit", () => ({
      data: null,
      error: { message: "relation \"rate_limits\" does not exist" },
    }));
    expect(await checkRateLimit("registration")).toEqual({ allowed: true, count: 0 });
  });

  it("fails CLOSED for a caller that asked for it", async () => {
    // That reasoning does not survive being pointed at the login page: a
    // limiter that waves everything through when its counter is unreachable is
    // no limiter at all, during exactly the window an attacker benefits from.
    db.onRpc("bump_rate_limit", () => ({
      data: null,
      error: { message: "counter unavailable" },
    }));
    expect(await checkRateLimit("admin-login", { failClosed: true })).toEqual({
      allowed: false,
      count: 0,
    });
  });

  it("fails closed when the client throws, too", async () => {
    db.onRpc("bump_rate_limit", () => {
      throw new Error("connection reset");
    });
    expect(await checkRateLimit("admin-login", { failClosed: true })).toEqual({
      allowed: false,
      count: 0,
    });
  });

  it("still allows a fail-closed caller while the counter is healthy", async () => {
    countingRpc();
    expect(await checkRateLimit("admin-login", { failClosed: true })).toEqual({
      allowed: true,
      count: 1,
    });
  });

  it("says in the log which way it failed, and for which scope", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.onRpc("bump_rate_limit", () => ({ data: null, error: { message: "down" } }));

    await checkRateLimit("admin-login", { failClosed: true });
    await checkRateLimit("registration");

    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(logged[0]).toContain("DENYING");
    expect(logged[0]).toContain("admin-login");
    expect(logged[1]).toContain("allowing");
  });

  it("fails open when the client throws outright", async () => {
    db.onRpc("bump_rate_limit", () => {
      throw new Error("connection reset");
    });
    expect(await checkRateLimit("registration")).toEqual({ allowed: true, count: 0 });
  });

  it("fails open when the headers are unavailable", async () => {
    headersFail = new Error("outside a request scope");
    expect(await checkRateLimit("registration")).toEqual({ allowed: true, count: 0 });
  });

  it("treats a null count from the function as zero rather than NaN", async () => {
    db.onRpc("bump_rate_limit", () => ({ data: null, error: null }));
    const result = await checkRateLimit("registration");
    expect(result).toEqual({ allowed: true, count: 0 });
  });
});
