import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy.
 *
 * Stripe.js relies on the host page having a sane CSP — without one, an XSS
 * elsewhere on the site could tamper with the payment flow. Stripe's own
 * domains are allowlisted so hosted Checkout and the invoice pages keep
 * working, including `form-action`, which browsers apply to the redirect that
 * follows a server-action form submission.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // 'unsafe-eval' is only needed by the dev-mode React refresh runtime.
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval' " : ""}https://js.stripe.com https://*.stripe.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.stripe.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.supabase.co",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com",
  "form-action 'self' https://checkout.stripe.com https://*.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
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
