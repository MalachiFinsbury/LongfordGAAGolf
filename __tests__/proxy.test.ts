/**
 * Route protection and the per-request Content Security Policy.
 *
 * The proxy is the first thing in front of the dashboard, which holds every
 * registrant's name, email, phone and address behind one shared password. It is
 * deliberately not the *only* thing — app/admin/page.tsx re-verifies before
 * reading a row, and every money-moving server action verifies again — but a
 * matcher that quietly stopped covering a path would remove the outermost door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "@/proxy";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";

const ORIGIN = "https://golf.example.ie";

async function request(path: string, { token }: { token?: string } = {}) {
  const req = new NextRequest(new URL(path, ORIGIN));
  if (token !== undefined) req.cookies.set(SESSION_COOKIE, token);
  return proxy(req);
}

function directives(res: Response): Map<string, string> {
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  return new Map(
    csp.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name, rest.join(" ")] as const;
    })
  );
}

let validToken = "";

beforeEach(async () => {
  validToken = await createSessionToken();
});

describe("guarding the dashboard", () => {
  it("sends an anonymous visitor to the login page", async () => {
    const res = await request("/admin");

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
  });

  it("guards every path beneath /admin, not just the index", async () => {
    for (const path of ["/admin", "/admin/", "/admin/reports", "/admin/a/b"]) {
      const res = await request(path);
      // NextURL normalises a trailing slash, so match either spelling.
      expect(
        new URL(res.headers.get("location") ?? `${ORIGIN}/nowhere`).pathname,
        `${path} was not guarded`
      ).toMatch(/^\/admin\/login\/?$/);
    }
  });

  it("lets the login page itself through", async () => {
    const res = await request("/admin/login");
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets a signed-in organiser through", async () => {
    const res = await request("/admin", { token: validToken });
    expect(res.headers.get("location")).toBeNull();
  });

  it("turns away a forged cookie", async () => {
    const res = await request("/admin", { token: "authenticated.1.abc.deadbeef" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
  });

  it("turns away a token whose payload has been edited", async () => {
    // The signature covers the issue time, so moving it forward invalidates it.
    const [value, epoch, , signature] = validToken.split(".");
    const tampered = [value, epoch, (Date.now() + 1).toString(36), signature].join(".");

    const res = await request("/admin", { token: tampered });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
  });

  it("turns away a session that has aged out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const old = await createSessionToken();
    vi.setSystemTime(new Date("2026-09-01T18:00:00Z"));

    const res = await request("/admin", { token: old });
    vi.useRealTimers();

    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
  });

  it("turns away a session from a superseded epoch", async () => {
    vi.stubEnv("ADMIN_SESSION_EPOCH", "2");
    const res = await request("/admin", { token: validToken });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
  });

  it("leaves the public pages alone", async () => {
    for (const path of ["/", "/register/success"]) {
      const res = await request(path);
      expect(res.headers.get("location"), `${path} was redirected`).toBeNull();
    }
  });

  it("does not treat a lookalike path as the dashboard", async () => {
    // "/administrators" must not be swept up by a prefix test.
    const res = await request("/administrators");
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the content security policy", () => {
  it("is attached to every response, signed in or not", async () => {
    for (const res of [
      await request("/"),
      await request("/admin", { token: validToken }),
      await request("/admin/login"),
    ]) {
      expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    }
  });

  it("does not permit inline script", async () => {
    // The whole point of the nonce. With 'unsafe-inline' the policy would have
    // permitted exactly the injected script it exists to stop.
    const script = directives(await request("/")).get("script-src")!;
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).toMatch(/'nonce-[^']+'/);
    expect(script).toContain("'strict-dynamic'");
  });

  it("mints a fresh nonce per request", async () => {
    const first = directives(await request("/")).get("script-src")!;
    const second = directives(await request("/")).get("script-src")!;
    expect(first).not.toBe(second);
  });

  it("hands the same nonce to the renderer as to the browser", async () => {
    // Next reads it back off the request header during SSR; both halves are
    // required or the page's own scripts are blocked by its own policy.
    const res = await request("/");
    const sent = res.headers.get("x-middleware-request-x-nonce");
    const script = directives(res).get("script-src")!;

    expect(sent).toBeTruthy();
    expect(script).toContain(`'nonce-${sent}'`);
  });

  it("still allows Stripe's hosted pages to be reached and framed", async () => {
    const d = directives(await request("/"));
    // Browsers apply form-action to the redirect that follows a server action.
    expect(d.get("form-action")).toContain("https://checkout.stripe.com");
    expect(d.get("frame-src")).toContain("https://js.stripe.com");
    expect(d.get("connect-src")).toContain("https://api.stripe.com");
  });

  it("allows the app to reach Supabase", async () => {
    expect(directives(await request("/")).get("connect-src")).toContain(
      "https://*.supabase.co"
    );
  });

  it("refuses to be framed and pins the document base", async () => {
    const d = directives(await request("/"));
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'self'");
    expect(d.get("object-src")).toBe("'none'");
  });
});

describe("the matcher", () => {
  const source = config.matcher[0].source;
  const pattern = new RegExp(`^${source}$`);

  it("covers the pages a policy has to reach", () => {
    for (const path of ["/", "/admin", "/admin/login", "/register/success"]) {
      expect(pattern.test(path), `${path} is not matched`).toBe(true);
    }
  });

  it("leaves out what executes nothing, and the machine-to-machine webhook", () => {
    for (const path of [
      "/api/stripe/webhook",
      "/_next/static/chunk.js",
      "/_next/image",
      "/favicon.ico",
    ]) {
      expect(pattern.test(path), `${path} should not be matched`).toBe(false);
    }
  });

  it("skips prefetches, whose nonce would never reach a browser", () => {
    const missing = config.matcher[0].missing!.map((m) => m.key);
    expect(missing).toContain("next-router-prefetch");
    expect(missing).toContain("purpose");
  });
});
