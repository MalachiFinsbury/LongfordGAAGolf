import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { getStripe } from "./stripe.ts";
import { resolveCatalog, type ResolvedPrice } from "./catalog.ts";
import type { OrderLine } from "./pricing.ts";

/**
 * Tags every Checkout Session this flow creates, so the Dashboard can report
 * on it and compare it against any future variant. Stable by design: it
 * identifies the *flow*, not the individual session.
 */
const INTEGRATION_IDENTIFIER = "golf-classic-2026-qxvmtplh";

/** Payment terms for sponsors who ask to be invoiced. */
const INVOICE_DUE_DAYS = 30;

const EVENT_DESCRIPTION =
  "Longford GAA Golf Classic 2026 — Killeen Castle, Fri 18 Sep 2026";

export type PayerDetails = {
  registrationId: string;
  name: string;
  email: string;
  mobile: string;
  address: string | null;
};

/**
 * Idempotency key covering everything that could differ between attempts.
 *
 * Keying on the registration id alone was wrong: an abandoned checkout reuses
 * its row, so a payer who pressed Back, corrected a quantity and resubmitted
 * replayed the same key with different parameters — which Stripe rejects
 * outright ("Keys for idempotent requests can only be used with the same
 * parameters"). Folding the payload in means an identical retry still returns
 * the original object, while a genuine edit gets a fresh one.
 */
function attemptKey(payer: PayerDetails, lines: OrderLine[]): string {
  const material = [
    payer.registrationId,
    payer.name,
    payer.email,
    payer.mobile,
    payer.address ?? "",
    ...lines.map((l) => `${l.lookupKey}x${l.quantity}@${l.unitAmount ?? "fixed"}`),
  ].join("|");

  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Fixed-price lines reference the Stripe Price directly, so the amount charged
 * is whatever the catalogue says — the browser has no way to influence it.
 * Only donations carry an inline amount, and that is clamped upstream.
 */
function toCheckoutLineItems(
  lines: OrderLine[],
  catalog: Map<string, ResolvedPrice>
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return lines.map((line) => {
    const entry = catalog.get(line.lookupKey);
    if (!entry) throw new Error(`Unknown catalogue key: ${line.lookupKey}`);

    if (line.unitAmount === undefined) {
      return { price: entry.priceId, quantity: line.quantity };
    }
    return {
      price_data: {
        currency: "eur",
        product: entry.productId,
        unit_amount: line.unitAmount,
      },
      quantity: line.quantity,
    };
  });
}

export async function createCheckoutSession(
  payer: PayerDetails,
  lines: OrderLine[],
  origin: string
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const catalog = await resolveCatalog();
  const attempt = attemptKey(payer, lines);

  return stripe.checkout.sessions.create(
    {
      mode: "payment",
      // `payment_method_types` is deliberately omitted. That switches on
      // dynamic payment methods, so Stripe picks what to show each payer —
      // card, Link, Apple/Google Pay and anything else you enable later in
      // Dashboard settings — without a code change here.
      line_items: toCheckoutLineItems(lines, catalog),
      customer_email: payer.email,
      customer_creation: "always",
      client_reference_id: payer.registrationId,
      metadata: { registration_id: payer.registrationId },
      payment_intent_data: {
        description: `${EVENT_DESCRIPTION} — ${payer.name}`,
        metadata: { registration_id: payer.registrationId },
      },
      // Card payers get a proper invoice PDF too, so a company paying by card
      // still has something to give their accounts department.
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: EVENT_DESCRIPTION,
          metadata: { registration_id: payer.registrationId },
        },
      },
      integration_identifier: INTEGRATION_IDENTIFIER,
      success_url: `${origin}/register/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?payment=cancelled`,
    },
    // Guards against a network retry creating two sessions for one attempt.
    { idempotencyKey: `checkout:${attempt}` }
  );
}

/**
 * Creates a draft invoice, attaches the line items, then finalises and emails
 * it. The payer gets a hosted invoice page where they can pay by card or bank
 * transfer, and the organisers get a real invoice record in the Dashboard.
 */
export async function createAndSendInvoice(
  payer: PayerDetails,
  lines: OrderLine[]
): Promise<Stripe.Invoice> {
  const stripe = getStripe();
  const catalog = await resolveCatalog();
  const attempt = attemptKey(payer, lines);

  const customer = await stripe.customers.create(
    {
      name: payer.name,
      email: payer.email,
      phone: payer.mobile,
      address: payer.address ? { line1: payer.address, country: "IE" } : undefined,
      metadata: { registration_id: payer.registrationId },
    },
    { idempotencyKey: `customer:${attempt}` }
  );

  const draft = await stripe.invoices.create(
    {
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: INVOICE_DUE_DAYS,
      description: EVENT_DESCRIPTION,
      metadata: { registration_id: payer.registrationId },
      // We finalise and send explicitly below — don't let Stripe's automatic
      // collection race us to it while items are still being attached.
      auto_advance: false,
    },
    { idempotencyKey: `invoice:${attempt}` }
  );

  if (!draft.id) throw new Error("Stripe returned an invoice without an id.");

  for (const [index, line] of lines.entries()) {
    const entry = catalog.get(line.lookupKey);
    if (!entry) throw new Error(`Unknown catalogue key: ${line.lookupKey}`);

    await stripe.invoiceItems.create(
      {
        customer: customer.id,
        invoice: draft.id,
        quantity: line.quantity,
        ...(line.unitAmount === undefined
          ? { pricing: { price: entry.priceId } }
          : {
              price_data: {
                currency: "eur",
                product: entry.productId,
                unit_amount: line.unitAmount,
              },
            }),
      },
      { idempotencyKey: `invoiceitem:${attempt}:${index}` }
    );
  }

  // Re-read before acting. On an idempotent replay `draft` is the *cached*
  // response from the original call, so it still claims to be a draft even
  // though the real invoice was finalised on the first pass — and finalising
  // twice is an error. Driving off current status keeps this safe to retry.
  const current = await stripe.invoices.retrieve(draft.id);
  const finalised =
    current.status === "draft"
      ? await stripe.invoices.finalizeInvoice(draft.id)
      : current;

  // Only an open invoice can be sent; a paid or voided one is already done.
  return finalised.status === "open"
    ? stripe.invoices.sendInvoice(draft.id)
    : finalised;
}
