import Stripe from "stripe";

/**
 * Server-only Stripe client. The secret key must never reach the browser —
 * this module is only ever imported from server actions and route handlers.
 */
let client: Stripe | null = null;

export function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY. See .env.example.");
  }
  if (!client) {
    client = new Stripe(secretKey, {
      // Pin the version the SDK was generated against so a Stripe-side
      // upgrade can never silently change response shapes under us.
      apiVersion: "2026-06-24.dahlia",
      appInfo: {
        name: "Longford GAA Golf Classic",
        url: "https://longford-gaa-golf.vercel.app",
      },
    });
  }
  return client;
}
