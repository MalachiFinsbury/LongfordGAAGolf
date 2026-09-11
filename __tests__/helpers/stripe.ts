import { vi } from "vitest";
import { CATALOG } from "@/lib/catalog";

/**
 * A recording stand-in for the Stripe client.
 *
 * Only the calls this app actually makes are implemented, and each records the
 * options it was given — the idempotency keys in particular, since those are
 * what stop a retried registration charging twice.
 */

export type StripeCall = { method: string; args: unknown[] };

export type FakePrice = {
  id: string;
  lookup_key: string | null;
  unit_amount: number | null;
  currency: string;
  product: string | { id: string };
  active?: boolean;
};

/** The catalogue exactly as `npm run stripe:setup` would leave it. */
export function catalogPrices(): FakePrice[] {
  return Object.entries(CATALOG).map(([key, entry]) => ({
    id: `price_${key}`,
    lookup_key: entry.lookupKey,
    unit_amount: Math.round(entry.euro * 100),
    currency: "eur",
    product: `prod_${key}`,
    active: true,
  }));
}

export class FakeStripe {
  calls: StripeCall[] = [];

  /** What `prices.list` will return; swap it to simulate a broken catalogue. */
  prices_data: FakePrice[] = catalogPrices();

  /** Invoice status sequence for `invoices.retrieve`, consumed in order. */
  private invoiceStatuses: string[] = [];

  /** Errors to throw, keyed by method name. */
  private throwOn = new Map<string, Error>();

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    const boom = this.throwOn.get(method);
    if (boom) throw boom;
  }

  /** Options passed alongside the body — where the idempotency key lives. */
  optionsFor(method: string): Record<string, unknown> | undefined {
    const call = this.calls.find((c) => c.method === method);
    return call?.args[1] as Record<string, unknown> | undefined;
  }

  bodyFor<T = Record<string, unknown>>(method: string): T {
    const call = this.calls.find((c) => c.method === method);
    return call?.args[0] as T;
  }

  callsTo(method: string): StripeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  failOn(method: string, error: Error) {
    this.throwOn.set(method, error);
  }

  /** Drives what `invoices.retrieve` reports, one status per call. */
  queueInvoiceStatuses(...statuses: string[]) {
    this.invoiceStatuses = statuses;
  }

  prices = {
    list: async (params: unknown) => {
      this.record("prices.list", params);
      return { data: this.prices_data };
    },
  };

  checkout = {
    sessions: {
      create: async (body: Record<string, unknown>, options?: unknown) => {
        this.record("checkout.sessions.create", body, options);
        return {
          id: "cs_test_123",
          url: "https://checkout.stripe.com/c/pay/cs_test_123",
          ...(this.sessionOverrides ?? {}),
        };
      },
      retrieve: async (id: string, params?: unknown) => {
        this.record("checkout.sessions.retrieve", id, params);
        return {
          id,
          amount_total: 220000,
          payment_status: "paid",
          customer_details: { email: "payer@example.ie" },
          invoice: {
            id: "in_test_1",
            hosted_invoice_url: "https://invoice.stripe.com/i/test",
          },
          ...(this.retrievedSessionOverrides ?? {}),
        };
      },
    },
  };

  /** Overrides merged into the object `checkout.sessions.create` returns. */
  sessionOverrides: Record<string, unknown> | null = null;
  /** Overrides merged into the object `checkout.sessions.retrieve` returns. */
  retrievedSessionOverrides: Record<string, unknown> | null = null;

  customers = {
    create: async (body: Record<string, unknown>, options?: unknown) => {
      this.record("customers.create", body, options);
      return { id: "cus_test_1", ...body };
    },
  };

  invoiceItems = {
    create: async (body: Record<string, unknown>, options?: unknown) => {
      this.record("invoiceItems.create", body, options);
      return { id: `ii_${this.callsTo("invoiceItems.create").length}` };
    },
  };

  invoices = {
    create: async (body: Record<string, unknown>, options?: unknown) => {
      this.record("invoices.create", body, options);
      return { id: "in_test_1", status: "draft", ...body };
    },
    retrieve: async (id: string) => {
      this.record("invoices.retrieve", id);
      const status = this.invoiceStatuses.shift() ?? "draft";
      return { id, status };
    },
    finalizeInvoice: async (id: string) => {
      this.record("invoices.finalizeInvoice", id);
      return { id, status: "open" };
    },
    sendInvoice: async (id: string) => {
      this.record("invoices.sendInvoice", id);
      return {
        id,
        status: "open",
        number: "LGC-0001",
        customer: "cus_test_1",
        hosted_invoice_url: "https://invoice.stripe.com/i/test",
      };
    },
  };

  webhooks = {
    constructEventAsync: async (payload: string, signature: string, secret: string) => {
      this.record("webhooks.constructEventAsync", payload, signature, secret);
      if (signature !== validSignatureFor(payload, secret)) {
        throw new Error("No signatures found matching the expected signature for payload.");
      }
      return JSON.parse(payload);
    },
  };
}

/**
 * The signature the fake verifier accepts. Not Stripe's real scheme — the point
 * is that the route rejects a payload whose signature does not match the bytes,
 * which this reproduces without reimplementing their HMAC.
 */
export function validSignatureFor(payload: string, secret: string): string {
  let hash = 0;
  for (const ch of `${secret}:${payload}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return `t=1,v1=${(hash >>> 0).toString(16)}`;
}

/** Installs the fake in place of `getStripe()` and returns it. */
export function mockStripe(stripe: FakeStripe = new FakeStripe()) {
  vi.doMock("@/lib/stripe", () => ({ getStripe: () => stripe }));
  return stripe;
}
