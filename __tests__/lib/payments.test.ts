import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStripe, catalogPrices } from "../helpers/stripe";
import type { OrderLine } from "@/lib/pricing";


const stripe = new FakeStripe();

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));

const { clearCatalogCache } = await import("@/lib/catalog");
const { createAndSendInvoice, createCheckoutSession } = await import("@/lib/payments");
const { CATALOG } = await import("@/lib/catalog");

const ORIGIN = "https://golf.example.ie";

/** Just enough of each Stripe request body for the assertions below. */
type Meta = { registration_id?: string };
type CheckoutBody = {
  mode?: string;
  client_reference_id?: string;
  customer_email?: string;
  customer_creation?: string;
  payment_method_types?: unknown;
  metadata?: Meta;
  payment_intent_data?: { description?: string; metadata?: Meta };
  invoice_creation?: { enabled?: boolean; invoice_data?: { metadata?: Meta } };
  success_url?: string;
  cancel_url?: string;
};
type CustomerBody = {
  name?: string;
  email?: string;
  phone?: string;
  address?: { line1: string; country: string };
  metadata?: Meta;
};
type InvoiceBody = {
  collection_method?: string;
  days_until_due?: number;
  auto_advance?: boolean;
  metadata?: Meta;
};
type InvoiceItemBody = {
  quantity?: number;
  pricing?: { price: string };
  price_data?: { currency: string; product: string; unit_amount: number };
};
type Idempotent = { idempotencyKey: string };

const payer = {
  registrationId: "11111111-2222-4333-8444-000000000001",
  name: "Máire Ní Bhriain",
  email: "maire@example.ie",
  mobile: "0871234567",
  address: "1 Main Street, Longford",
};

const teamLine: OrderLine = { lookupKey: CATALOG.team.lookupKey, quantity: 2 };
const donationLine: OrderLine = {
  lookupKey: CATALOG.donation.lookupKey,
  quantity: 1,
  unitAmount: 5000,
};

beforeEach(() => {
  stripe.calls = [];
  stripe.prices_data = catalogPrices();
  stripe.sessionOverrides = null;
  stripe.queueInvoiceStatuses();
  clearCatalogCache();
});

describe("createCheckoutSession", () => {
  it("returns the session Stripe created", async () => {
    const session = await createCheckoutSession(payer, [teamLine], ORIGIN);
    expect(session.url).toContain("checkout.stripe.com");
  });

  it("bills fixed lines by Price id, so the browser cannot set an amount", async () => {
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    const { line_items } = stripe.bodyFor<{
      line_items: Array<Record<string, unknown>>;
    }>("checkout.sessions.create");

    expect(line_items).toEqual([{ price: "price_team", quantity: 2 }]);
    // No amount of any kind travels with a fixed line.
    expect(JSON.stringify(line_items)).not.toMatch(/unit_amount|price_data/);
  });

  it("sends a donation as an inline amount against the donation product", async () => {
    await createCheckoutSession(payer, [donationLine], ORIGIN);
    const { line_items } = stripe.bodyFor<{ line_items: Array<Record<string, unknown>> }>(
      "checkout.sessions.create"
    );
    expect(line_items).toEqual([
      {
        price_data: { currency: "eur", product: "prod_donation", unit_amount: 5000 },
        quantity: 1,
      },
    ]);
  });

  it("ties the session back to the registration three ways", async () => {
    // The webhook reads whichever of these arrives, so all three must be set:
    // a session with no registration id is a payment nobody can reconcile.
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    const body = stripe.bodyFor<CheckoutBody>("checkout.sessions.create");

    expect(body.client_reference_id).toBe(payer.registrationId);
    expect(body.metadata?.registration_id).toBe(payer.registrationId);
    expect(body.payment_intent_data?.metadata?.registration_id).toBe(payer.registrationId);
  });

  it("returns the payer to this deployment, not a hardcoded host", async () => {
    await createCheckoutSession(payer, [teamLine], "https://preview-abc.vercel.app");
    const body = stripe.bodyFor<CheckoutBody>("checkout.sessions.create");

    expect(body.success_url).toBe(
      "https://preview-abc.vercel.app/register/success?session_id={CHECKOUT_SESSION_ID}"
    );
    expect(body.cancel_url).toBe("https://preview-abc.vercel.app/?payment=cancelled");
  });

  it("leaves payment method types unset so Stripe can offer Link and wallets", async () => {
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    const body = stripe.bodyFor<Record<string, unknown>>("checkout.sessions.create");
    expect(body.payment_method_types).toBeUndefined();
    expect(body.mode).toBe("payment");
  });

  it("asks Stripe to raise an invoice, so a company payer has something to file", async () => {
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    const body = stripe.bodyFor<CheckoutBody>("checkout.sessions.create");
    expect(body.invoice_creation?.enabled).toBe(true);
    expect(body.invoice_creation?.invoice_data?.metadata?.registration_id).toBe(
      payer.registrationId
    );
    expect(body.customer_email).toBe(payer.email);
  });

  it("guards a network retry with an idempotency key", async () => {
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    const options = stripe.optionsFor("checkout.sessions.create") as Idempotent;
    expect(options.idempotencyKey).toMatch(/^checkout:[0-9a-f]{32}$/);
  });

  it("reuses the key for an identical retry", async () => {
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    const [first, second] = stripe
      .callsTo("checkout.sessions.create")
      .map((c) => (c.args[1] as Idempotent).idempotencyKey);
    expect(first).toBe(second);
  });

  it("uses a fresh key once a quantity changes", async () => {
    // The bug this guards: keying on the registration id alone meant a payer
    // who pressed Back, corrected a quantity and resubmitted replayed the same
    // key with different parameters, which Stripe rejects outright.
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    await createCheckoutSession(payer, [{ ...teamLine, quantity: 3 }], ORIGIN);
    const [first, second] = stripe
      .callsTo("checkout.sessions.create")
      .map((c) => (c.args[1] as Idempotent).idempotencyKey);
    expect(first).not.toBe(second);
  });

  it("uses a fresh key once the payer's own details change", async () => {
    await createCheckoutSession(payer, [teamLine], ORIGIN);
    await createCheckoutSession({ ...payer, email: "other@example.ie" }, [teamLine], ORIGIN);
    const keys = stripe
      .callsTo("checkout.sessions.create")
      .map((c) => (c.args[1] as Idempotent).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("distinguishes a donation amount from an otherwise identical basket", async () => {
    await createCheckoutSession(payer, [donationLine], ORIGIN);
    await createCheckoutSession(payer, [{ ...donationLine, unitAmount: 7500 }], ORIGIN);
    const keys = stripe
      .callsTo("checkout.sessions.create")
      .map((c) => (c.args[1] as Idempotent).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("refuses a line that is not in the catalogue", async () => {
    await expect(
      createCheckoutSession(payer, [{ lookupKey: "gc2026_pony_rides", quantity: 1 }], ORIGIN)
    ).rejects.toThrow(/Unknown catalogue key: gc2026_pony_rides/);
  });

  it("propagates a catalogue that cannot be resolved rather than charging a guess", async () => {
    stripe.prices_data = [];
    clearCatalogCache();
    await expect(createCheckoutSession(payer, [teamLine], ORIGIN)).rejects.toThrow(
      /missing prices/
    );
    expect(stripe.callsTo("checkout.sessions.create")).toHaveLength(0);
  });
});

describe("createAndSendInvoice", () => {
  it("creates the customer from the payer's own details", async () => {
    await createAndSendInvoice(payer, [teamLine]);
    const body = stripe.bodyFor<CustomerBody>("customers.create");

    expect(body.email).toBe(payer.email);
    expect(body.name).toBe(payer.name);
    expect(body.phone).toBe(payer.mobile);
    expect(body.address).toEqual({ line1: payer.address, country: "IE" });
    expect(body.metadata?.registration_id).toBe(payer.registrationId);
  });

  it("omits the address block entirely when none was given", async () => {
    await createAndSendInvoice({ ...payer, address: null }, [teamLine]);
    expect(stripe.bodyFor<CustomerBody>("customers.create").address).toBeUndefined();
  });

  it("raises the invoice on send-invoice terms, not automatic charging", async () => {
    await createAndSendInvoice(payer, [teamLine]);
    const body = stripe.bodyFor<InvoiceBody>("invoices.create");

    expect(body.collection_method).toBe("send_invoice");
    expect(body.days_until_due).toBe(30);
    // Auto-advance off so Stripe cannot finalise the invoice while items are
    // still being attached to it.
    expect(body.auto_advance).toBe(false);
    expect(body.metadata?.registration_id).toBe(payer.registrationId);
  });

  it("attaches one invoice item per line, priced from the catalogue", async () => {
    await createAndSendInvoice(payer, [teamLine, donationLine]);
    const items = stripe.callsTo("invoiceItems.create").map((c) => c.args[0] as InvoiceItemBody);

    expect(items).toHaveLength(2);
    expect(items[0].pricing).toEqual({ price: "price_team" });
    expect(items[0].quantity).toBe(2);
    expect(items[1].price_data).toEqual({
      currency: "eur",
      product: "prod_donation",
      unit_amount: 5000,
    });
  });

  it("gives each invoice item its own idempotency key", async () => {
    // A shared key would make Stripe replay the first item for the second, so
    // an entry with a team and a donation would be invoiced for two teams.
    await createAndSendInvoice(payer, [teamLine, donationLine]);
    const keys = stripe
      .callsTo("invoiceItems.create")
      .map((c) => (c.args[1] as Idempotent).idempotencyKey);

    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toMatch(/^invoiceitem:[0-9a-f]{32}:0$/);
    expect(keys[1]).toMatch(/^invoiceitem:[0-9a-f]{32}:1$/);
  });

  it("finalises a draft and then emails it", async () => {
    stripe.queueInvoiceStatuses("draft");
    const invoice = await createAndSendInvoice(payer, [teamLine]);

    expect(stripe.callsTo("invoices.finalizeInvoice")).toHaveLength(1);
    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(1);
    expect(invoice.hosted_invoice_url).toContain("invoice.stripe.com");
  });

  it("does not finalise twice when an idempotent replay returns a stale draft", async () => {
    // On a replay `draft` is the cached response from the original call, so it
    // still claims to be a draft even though the real invoice was finalised.
    // Driving off the re-read status is what keeps this safe to retry.
    stripe.queueInvoiceStatuses("open");
    await createAndSendInvoice(payer, [teamLine]);

    expect(stripe.callsTo("invoices.finalizeInvoice")).toHaveLength(0);
    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(1);
  });

  it("does not re-send an invoice that is already paid", async () => {
    stripe.queueInvoiceStatuses("paid");
    const invoice = await createAndSendInvoice(payer, [teamLine]);

    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(0);
    expect(invoice.status).toBe("paid");
  });

  it("does not re-send a voided invoice", async () => {
    stripe.queueInvoiceStatuses("void");
    await createAndSendInvoice(payer, [teamLine]);
    expect(stripe.callsTo("invoices.sendInvoice")).toHaveLength(0);
  });

  it("refuses a line that is not in the catalogue before billing anything", async () => {
    await expect(
      createAndSendInvoice(payer, [{ lookupKey: "gc2026_mystery", quantity: 1 }])
    ).rejects.toThrow(/Unknown catalogue key/);
    expect(stripe.callsTo("invoiceItems.create")).toHaveLength(0);
  });

  it("keys the customer, the invoice and the items off the same attempt", async () => {
    await createAndSendInvoice(payer, [teamLine]);
    const attemptOf = (key: string) => key.split(":")[1];

    const customerKey = (stripe.optionsFor("customers.create") as Idempotent).idempotencyKey;
    const invoiceKey = (stripe.optionsFor("invoices.create") as Idempotent).idempotencyKey;
    const itemKey = (stripe.optionsFor("invoiceItems.create") as Idempotent).idempotencyKey;

    expect(attemptOf(invoiceKey)).toBe(attemptOf(customerKey));
    expect(attemptOf(itemKey)).toBe(attemptOf(customerKey));
  });
});
