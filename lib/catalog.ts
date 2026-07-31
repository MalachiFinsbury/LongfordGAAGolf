import type Stripe from "stripe";
// Explicit .ts extensions so `scripts/setup-stripe-catalog.ts` can import this
// module directly under Node's type stripping, which resolves as strict ESM.
import { getStripe } from "./stripe.ts";
import { PRICE_PER_TEAM, PRICE_PER_TEE_BOX, PRICE_PER_GREEN } from "./types.ts";

/**
 * The Stripe product catalogue for the 2026 classic.
 *
 * Each entry is one Stripe Product with one Price carrying a stable
 * `lookup_key`. Lookup keys — not hardcoded `price_...` IDs — are what the app
 * resolves at runtime, so the same code works unchanged against the test
 * sandbox and the live account.
 *
 * Run `npm run stripe:setup` to create anything missing (idempotent).
 */
export const CATALOG = {
  team: {
    lookupKey: "gc2026_team",
    name: "Golf Classic 2026 — Team entry (4 players)",
    description: "Entry for one team of four at Killeen Castle, Fri 18 Sep 2026.",
    euro: PRICE_PER_TEAM,
  },
  teeBox: {
    lookupKey: "gc2026_tee_box",
    name: "Golf Classic 2026 — Tee box sponsorship",
    description: "Branded signage on one tee box for the duration of the classic.",
    euro: PRICE_PER_TEE_BOX,
  },
  green: {
    lookupKey: "gc2026_green",
    name: "Golf Classic 2026 — Green sponsorship",
    description: "Branded signage on one green for the duration of the classic.",
    euro: PRICE_PER_GREEN,
  },
  /**
   * Donations are variable-amount, so the Price attached to this Product is a
   * nominal placeholder. We only ever read `price.product` off it and supply
   * the real amount inline via `price_data`.
   */
  donation: {
    lookupKey: "gc2026_donation",
    name: "Golf Classic 2026 — Donation",
    description: "Voluntary donation supporting Gaelic games in County Longford.",
    euro: 1,
  },
} as const;

export const CATALOG_LOOKUP_KEYS = Object.values(CATALOG).map((c) => c.lookupKey);

export type ResolvedPrice = { priceId: string; productId: string };

/**
 * Cached across invocations within a warm server instance — the catalogue is
 * static, so re-listing it on every registration would be wasted latency.
 */
let cache: Map<string, ResolvedPrice> | null = null;

export async function resolveCatalog(): Promise<Map<string, ResolvedPrice>> {
  if (cache) return cache;

  const stripe = getStripe();
  const { data } = await stripe.prices.list({
    lookup_keys: CATALOG_LOOKUP_KEYS,
    active: true,
    limit: CATALOG_LOOKUP_KEYS.length,
  });

  const resolved = new Map<string, ResolvedPrice>();
  for (const price of data) {
    if (!price.lookup_key) continue;
    resolved.set(price.lookup_key, {
      priceId: price.id,
      productId: typeof price.product === "string" ? price.product : price.product.id,
    });
  }

  const missing = CATALOG_LOOKUP_KEYS.filter((k) => !resolved.has(k));
  if (missing.length > 0) {
    throw new Error(
      `Stripe catalogue is missing prices for: ${missing.join(", ")}. ` +
        `Run \`npm run stripe:setup\` against this account first.`
    );
  }

  // Guard against silent drift. The figures in lib/types.ts drive both the
  // total shown on the form and the amount stored in Supabase, while Stripe
  // charges whatever its Price says. If someone edits a constant without
  // re-running the catalogue setup, those two diverge and the admin dashboard
  // starts reporting numbers that were never charged. Refuse instead.
  for (const [key, price] of data.map((p) => [p.lookup_key, p] as const)) {
    if (!key || key === CATALOG.donation.lookupKey) continue; // donation is variable
    const entry = Object.values(CATALOG).find((c) => c.lookupKey === key);
    if (!entry) continue;

    const expected = Math.round(entry.euro * 100);
    if (price.unit_amount !== expected) {
      throw new Error(
        `Price mismatch for "${key}": Stripe charges ${price.unit_amount} cents ` +
          `but the app displays ${expected}. Reconcile lib/types.ts with the ` +
          `Stripe catalogue before taking payments.`
      );
    }
    if (price.currency !== "eur") {
      throw new Error(`Price "${key}" is in ${price.currency}, expected eur.`);
    }
  }

  cache = resolved;
  return resolved;
}

/** Test helper / used by the setup script to force a re-read. */
export function clearCatalogCache() {
  cache = null;
}

export type { Stripe };
