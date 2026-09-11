import type { NextConfig } from "next";

/**
 * The Content-Security-Policy now lives in proxy.ts, not here.
 *
 * It has to be built per request to carry a nonce, and a static copy left in
 * this file would not merely be redundant — a response carrying two CSP headers
 * is held to *both*, so the old 'unsafe-inline' policy and the new nonce policy
 * would intersect into one that blocks every script on the page.
 *
 * The headers below have no per-request component, so they stay here, where
 * they also cover the static assets that proxy.ts deliberately skips.
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // Nothing here needs a camera, mic or the payment request API
          // directly — Stripe's hosted pages handle payment on their own origin.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
