/**
 * Creates the Stripe Product + Price catalogue for the Golf Classic.
 *
 * Idempotent: it looks for each Price by its stable `lookup_key` and only
 * creates what is missing, so it is safe to re-run — including against the
 * live account when you go live.
 *
 *   npm run stripe:setup
 *
 * Reads STRIPE_SECRET_KEY from .env.local (see package.json).
 */
import Stripe from "stripe";
// Explicit .ts extension: this file runs directly under Node's type stripping,
// which resolves as ESM and needs the real filename.
import { CATALOG } from "../lib/catalog.ts";

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error("Missing STRIPE_SECRET_KEY — set it in .env.local first.");
  process.exit(1);
}

const stripe = new Stripe(secretKey, { apiVersion: "2026-06-24.dahlia" });

const mode = secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_") ? "LIVE" : "test";

async function main() {
  // `null` means "whichever account this API key belongs to".
  const account = await stripe.accounts.retrieve(null);
  console.log(
    `\nStripe catalogue setup — ${mode} mode · ${account.settings?.dashboard?.display_name ?? account.id}\n`
  );

  for (const entry of Object.values(CATALOG)) {
    const existing = await stripe.prices.list({
      lookup_keys: [entry.lookupKey],
      active: true,
      limit: 1,
    });

    if (existing.data.length > 0) {
      const price = existing.data[0];
      console.log(`  = ${entry.lookupKey.padEnd(18)} exists  ${price.id}`);
      continue;
    }

    const product = await stripe.products.create(
      {
        name: entry.name,
        description: entry.description,
        metadata: { catalog_key: entry.lookupKey },
      },
      { idempotencyKey: `product:${entry.lookupKey}` }
    );

    const price = await stripe.prices.create(
      {
        product: product.id,
        currency: "eur",
        unit_amount: Math.round(entry.euro * 100),
        lookup_key: entry.lookupKey,
        metadata: { catalog_key: entry.lookupKey },
      },
      { idempotencyKey: `price:${entry.lookupKey}` }
    );

    console.log(`  + ${entry.lookupKey.padEnd(18)} created ${price.id}  (${product.id})`);
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("\nCatalogue setup failed:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
