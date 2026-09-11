import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * Content Security Policy.
 *
 * Built per request rather than declared in next.config.ts, because the whole
 * point is the nonce: a fresh unguessable value each time, which Next.js then
 * stamps onto its own framework and page scripts during SSR. That is what lets
 * `script-src` drop 'unsafe-inline' — a directive which, while it was there,
 * meant the policy would have permitted exactly the injected inline script it
 * exists to stop.
 *
 * `'strict-dynamic'` lets those nonced bundles load the chunks they need
 * without enumerating every path; browsers that honour it ignore the 'self'
 * fallback, and older ones fall back to it.
 *
 * `style-src` deliberately keeps 'unsafe-inline'. next/font injects a style
 * block, and the dashboard sets one width inline for its progress bar; inline
 * *styles* are a far narrower problem than inline scripts, and pretending
 * otherwise would mean a policy nobody can keep. Revisit if those two go away.
 */
function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' is only needed by the dev-mode React refresh runtime.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.stripe.com",
    "font-src 'self' data:",
    "connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.supabase.co",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com",
    // Browsers apply form-action to the redirect that follows a server-action
    // form submission, so Stripe's hosted pages have to be listed here.
    "form-action 'self' https://checkout.stripe.com https://*.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only guard the dashboard itself, not the login page. This is an optimistic
  // check in the sense Next's own auth guide means it — app/admin/page.tsx
  // re-verifies before reading a single row, and every server action that
  // mutates payment state verifies again.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (pathname !== "/admin/login") {
      const token = request.cookies.get(SESSION_COOKIE)?.value;
      if (!(await verifySessionToken(token))) {
        const url = request.nextUrl.clone();
        url.pathname = "/admin/login";
        return NextResponse.redirect(url);
      }
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV !== "production");

  // Next.js reads the nonce back off the *request* header during SSR and
  // applies it to the scripts it emits, so both halves are required.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every document request, so the CSP is never missing from a page that
     * renders. Excluded: API routes (the Stripe webhook is machine-to-machine
     * and a CSP means nothing to it), static assets and optimised images, all
     * of which are served without executing anything.
     *
     * Prefetches are skipped too — they return RSC payloads rather than
     * documents, and a nonce minted for one would never reach a browser.
     */
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
