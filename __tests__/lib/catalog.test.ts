import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStripe, catalogPrices } from "../helpers/stripe";

const stripe = new FakeStripe();

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));

const { CATALOG, CATALOG_LOOKUP_KEYS, clearCatalogCache, resolveCatalog } = await import(
  "@/lib/catalog"
);

beforeEach(() => {
  clearCatalogCache();
  stripe.calls = [];
  stripe.prices_data = catalogPrices();
});

describe("CATALOG", () => {
  it("gives every product a distinct, stable lookup key", () => {
    expect(new Set(CATALOG_LOOKUP_KEYS).size).toBe(CATALOG_LOOKUP_KEYS.length);
    for (const key of CATALOG_LOOKUP_KEYS) {
      expect(key).toMatch(/^gc2026_[a-z_]+$/);
    }
  });

  it("prices the billable products from the same constants the form displays", () => {
    expect(CATALOG.team.euro).toBe(2200);
    expect(CATALOG.teeBox.euro).toBe(500);
    expect(CATALOG.green.euro).toBe(500);
  });
});

describe("resolveCatalog", () => {
  it("maps every lookup key to its price and product", async () => {
    const resolved = await resolveCatalog();
    expect(resolved.get(CATALOG.team.lookupKey)).toEqual({
      priceId: "price_team",
      productId: "prod_team",
    });
    expect(resolved.size).toBe(CATALOG_LOOKUP_KEYS.length);
  });

  it("asks Stripe only for the active prices it needs", async () => {
    await resolveCatalog();
    const params = stripe.bodyFor<{
      lookup_keys: string[];
      active: boolean;
    }>("prices.list");
    expect(params.active).toBe(true);
    // Copied before sorting: `lookup_keys` is the module's own array, and
    // sorting it in place would reorder the catalogue for every later test.
    expect([...params.lookup_keys].sort()).toEqual([...CATALOG_LOOKUP_KEYS].sort());
  });

  it("unwraps an expanded product object as well as a bare id", async () => {
    stripe.prices_data = catalogPrices().map((p) =>
      p.lookup_key === CATALOG.green.lookupKey
        ? { ...p, product: { id: "prod_green_expanded" } }
        : p
    );
    const resolved = await resolveCatalog();
    expect(resolved.get(CATALOG.green.lookupKey)?.productId).toBe("prod_green_expanded");
  });

  it("caches across calls, so a busy form does not re-list the catalogue", async () => {
    await resolveCatalog();
    await resolveCatalog();
    expect(stripe.callsTo("prices.list")).toHaveLength(1);
  });

  it("re-reads once the cache is cleared", async () => {
    await resolveCatalog();
    clearCatalogCache();
    await resolveCatalog();
    expect(stripe.callsTo("prices.list")).toHaveLength(2);
  });

  it("refuses, naming the products, when the catalogue was never set up", async () => {
    stripe.prices_data = [];
    await expect(resolveCatalog()).rejects.toThrow(/missing prices for: gc2026_team/);
    await expect(resolveCatalog()).rejects.toThrow(/npm run stripe:setup/);
  });

  it("refuses when a single product is missing", async () => {
    stripe.prices_data = catalogPrices().filter(
      (p) => p.lookup_key !== CATALOG.teeBox.lookupKey
    );
    await expect(resolveCatalog()).rejects.toThrow(/gc2026_tee_box/);
  });

  it("refuses when Stripe would charge a different price than the form shows", async () => {
    // The failure this prevents: the constants drive both the total on the form
    // and the figure stored in Supabase, while Stripe charges whatever its
    // Price says. Silently diverging means the dashboard reports money that was
    // never collected.
    stripe.prices_data = catalogPrices().map((p) =>
      p.lookup_key === CATALOG.team.lookupKey ? { ...p, unit_amount: 250000 } : p
    );
    await expect(resolveCatalog()).rejects.toThrow(
      /Price mismatch for "gc2026_team": Stripe charges 250000 cents but the app displays 220000/
    );
  });

  it("refuses when a price is in the wrong currency", async () => {
    stripe.prices_data = catalogPrices().map((p) =>
      p.lookup_key === CATALOG.green.lookupKey ? { ...p, currency: "usd" } : p
    );
    await expect(resolveCatalog()).rejects.toThrow(/is in usd, expected eur/);
  });

  it("exempts the donation, whose price is a variable-amount placeholder", async () => {
    stripe.prices_data = catalogPrices().map((p) =>
      p.lookup_key === CATALOG.donation.lookupKey ? { ...p, unit_amount: 999 } : p
    );
    await expect(resolveCatalog()).resolves.toBeInstanceOf(Map);
  });

  it("does not cache a catalogue it rejected", async () => {
    // Otherwise the first bad read would poison every later one — or worse, a
    // half-built map would be served as if it were complete.
    stripe.prices_data = [];
    await expect(resolveCatalog()).rejects.toThrow();

    stripe.prices_data = catalogPrices();
    const resolved = await resolveCatalog();
    expect(resolved.size).toBe(CATALOG_LOOKUP_KEYS.length);
  });

  it("ignores a price that carries no lookup key at all", async () => {
    stripe.prices_data = [
      ...catalogPrices(),
      { id: "price_stray", lookup_key: null, unit_amount: 1, currency: "eur", product: "prod_x" },
    ];
    const resolved = await resolveCatalog();
    expect(resolved.size).toBe(CATALOG_LOOKUP_KEYS.length);
  });
});
