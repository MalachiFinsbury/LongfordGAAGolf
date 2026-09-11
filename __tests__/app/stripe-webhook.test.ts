/**
 * The Stripe webhook — the only place the app is allowed to conclude that a
 * registration has been paid.
 *
 * Everything here is about money arriving exactly once: a forged request must
 * not settle anything, a redelivery must not double-count, and the two paid
 * events a single card checkout produces must not send the payer two receipts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { FakeSupabase } from "../helpers/supabase";
import { registration } from "../helpers/factories";
import type { Registration } from "@/lib/types";

const db = new FakeSupabase();

/** What `constructEventAsync` should do with the next payload it is handed. */
let verify: (payload: string, signature: string) => Stripe.Event;

vi.mock("@/lib/supabase", () => ({ getAdminClient: () => db }));
vi.mock("@/lib/email", () => ({
  sendPaidConfirmation: vi.fn(async () => {}),
  sendTransferInstructions: vi.fn(async () => {}),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    webhooks: {
      constructEventAsync: async (payload: string, signature: string) =>
        verify(payload, signature),
    },
  }),
}));

const { POST } = await import("@/app/api/stripe/webhook/route");
const { sendPaidConfirmation } = await import("@/lib/email");

let eventSeq = 0;

/** Builds the minimum of a Stripe event that the handler actually reads. */
function event<T>(type: string, object: T, id = `evt_${++eventSeq}`): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

function post(e: Stripe.Event, { signature = "t=1,v1=good" } = {}): Promise<Response> {
  verify = () => e;
  return POST(
    new Request("https://golf.example.ie/api/stripe/webhook", {
      method: "POST",
      headers: signature ? { "stripe-signature": signature } : {},
      body: JSON.stringify(e),
    })
  );
}

function seed(overrides: Partial<Registration> = {}): Registration {
  const row = registration({ payment_method: "card", ...overrides });
  db.seed("registrations", [row as unknown as Record<string, unknown>]);
  return row;
}

function saved(id: string): Registration {
  return db.row<Registration>("registrations", id)!;
}

beforeEach(() => {
  db.reset();
  eventSeq = 0;
  verify = () => {
    throw new Error("no event configured");
  };
});

/* ------------------------------------------------------------------ *
 * Authenticity
 * ------------------------------------------------------------------ */

describe("webhook — authenticity", () => {
  it("refuses a request with no signature header", async () => {
    const row = seed();
    const res = await post(
      event("checkout.session.completed", { id: "cs_1", payment_status: "paid" }),
      { signature: "" }
    );

    expect(res.status).toBe(400);
    expect(saved(row.id).payment_status).toBe("pending");
  });

  it("refuses a payload whose signature does not verify", async () => {
    const row = seed();
    verify = () => {
      throw new Error("No signatures found matching the expected signature");
    };

    const res = await POST(
      new Request("https://golf.example.ie/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=forged" },
        body: JSON.stringify({
          id: "evt_forged",
          type: "checkout.session.completed",
          data: { object: { id: "cs_x", payment_status: "paid", metadata: { registration_id: row.id } } },
        }),
      })
    );

    expect(res.status).toBe(400);
    expect(saved(row.id).payment_status).toBe("pending");
    expect(db.rows("stripe_events")).toHaveLength(0);
  });

  it("will not run unconfigured rather than accepting anything", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const res = await post(event("checkout.session.completed", { id: "cs_1" }));
    expect(res.status).toBe(500);
  });

  it("verifies against the raw bytes, not a re-serialised body", async () => {
    // Re-encoding the JSON first would change the bytes the signature covers.
    const body = '{"id":"evt_raw","type":"ping","data":{"object":{}}}';
    let seenPayload: string | null = null;
    verify = (payload) => {
      seenPayload = payload;
      return event("ping", {}, "evt_raw");
    };

    await POST(
      new Request("https://golf.example.ie/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=good" },
        body,
      })
    );

    expect(seenPayload).toBe(body);
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

describe("webhook — idempotency", () => {
  it("records each event id once and ignores the redelivery", async () => {
    const row = seed();
    const e = event("checkout.session.completed", {
      id: "cs_1",
      payment_status: "paid",
      amount_total: 220000,
      metadata: { registration_id: row.id },
    });

    const first = await post(e);
    const second = await post(e);

    expect(await first.json()).toEqual({ received: true });
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(db.rows("stripe_events")).toHaveLength(1);
    expect(sendPaidConfirmation).toHaveBeenCalledTimes(1);
  });

  it("releases its claim when the handler fails, so the retry is a real attempt", async () => {
    const row = seed();
    db.failOnce("registrations", "update", { message: "connection reset" });

    const e = event("checkout.session.completed", {
      id: "cs_1",
      payment_status: "paid",
      amount_total: 220000,
      metadata: { registration_id: row.id },
    });

    const failed = await post(e);
    expect(failed.status).toBe(500);
    // Not left behind as a claim, or Stripe's retry would be waved through as
    // a duplicate and the payment would never be recorded.
    expect(db.rows("stripe_events")).toHaveLength(0);

    const retried = await post(e);
    expect(retried.status).toBe(200);
    expect(saved(row.id).payment_status).toBe("paid");
  });

  it("sends one receipt across the two different events a card checkout emits", async () => {
    // `invoice_creation` means checkout.session.completed AND invoice.paid both
    // land here. The event ledger cannot dedupe across two distinct ids, so the
    // claim is made on the row itself.
    const row = seed();

    await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        metadata: { registration_id: row.id },
      })
    );
    await post(
      event("invoice.paid", {
        id: "in_1",
        amount_paid: 220000,
        number: "LGC-0001",
        metadata: { registration_id: row.id },
      })
    );

    expect(sendPaidConfirmation).toHaveBeenCalledTimes(1);
    expect(saved(row.id).payment_status).toBe("paid");
    expect(saved(row.id).stripe_invoice_number).toBe("LGC-0001");
  });
});

/* ------------------------------------------------------------------ *
 * Settling a payment
 * ------------------------------------------------------------------ */

describe("webhook — checkout.session.completed", () => {
  it("marks the registration paid and records the Stripe references", async () => {
    const row = seed();

    await post(
      event("checkout.session.completed", {
        id: "cs_123",
        payment_status: "paid",
        amount_total: 225000,
        customer: "cus_1",
        payment_intent: "pi_1",
        invoice: "in_1",
        metadata: { registration_id: row.id },
      })
    );

    const after = saved(row.id);
    expect(after.payment_status).toBe("paid");
    expect(after.amount_paid).toBe(2250);
    expect(after.payment_recorded_by).toBe("stripe");
    expect(after.paid_at).toBeTruthy();
    expect(after.stripe_checkout_session_id).toBe("cs_123");
    expect(after.stripe_customer_id).toBe("cus_1");
    expect(after.stripe_payment_intent_id).toBe("pi_1");
  });

  it("reads an expanded object as readily as a bare id", async () => {
    const row = seed();
    await post(
      event("checkout.session.completed", {
        id: "cs_123",
        payment_status: "paid",
        amount_total: 220000,
        customer: { id: "cus_expanded" },
        payment_intent: { id: "pi_expanded" },
        metadata: { registration_id: row.id },
      })
    );

    expect(saved(row.id).stripe_customer_id).toBe("cus_expanded");
    expect(saved(row.id).stripe_payment_intent_id).toBe("pi_expanded");
  });

  it("falls back to client_reference_id when metadata is absent", async () => {
    const row = seed();
    await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        client_reference_id: row.id,
      })
    );
    expect(saved(row.id).payment_status).toBe("paid");
  });

  it("does not settle a session that completed while still unpaid", async () => {
    // Delayed methods complete the session before the money moves; the
    // async_payment_succeeded event is the one that settles it.
    const row = seed();
    await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "unpaid",
        amount_total: 220000,
        metadata: { registration_id: row.id },
      })
    );

    expect(saved(row.id).payment_status).toBe("pending");
    expect(sendPaidConfirmation).not.toHaveBeenCalled();
  });

  it("settles it later on async_payment_succeeded", async () => {
    const row = seed();
    await post(
      event("checkout.session.async_payment_succeeded", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        metadata: { registration_id: row.id },
      })
    );
    expect(saved(row.id).payment_status).toBe("paid");
  });

  it("acknowledges an event carrying no registration id instead of retrying forever", async () => {
    const res = await post(
      event("checkout.session.completed", { id: "cs_1", payment_status: "paid", amount_total: 100 })
    );
    expect(res.status).toBe(200);
    expect(sendPaidConfirmation).not.toHaveBeenCalled();
  });

  it("acknowledges an event type it does not care about", async () => {
    const res = await post(event("customer.created", { id: "cus_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});

describe("webhook — invoice.paid", () => {
  it("records the invoice and its hosted page", async () => {
    const row = seed({ payment_method: "invoice" });

    await post(
      event("invoice.paid", {
        id: "in_9",
        amount_paid: 220000,
        number: "LGC-0009",
        hosted_invoice_url: "https://invoice.stripe.com/i/abc",
        customer: "cus_9",
        metadata: { registration_id: row.id },
      })
    );

    const after = saved(row.id);
    expect(after.payment_status).toBe("paid");
    expect(after.amount_paid).toBe(2200);
    expect(after.stripe_invoice_id).toBe("in_9");
    expect(after.stripe_invoice_number).toBe("LGC-0009");
    expect(after.stripe_invoice_url).toBe("https://invoice.stripe.com/i/abc");
  });

  it("never blanks an id an earlier event already set", async () => {
    const row = seed();
    await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        customer: "cus_1",
        payment_intent: "pi_1",
        metadata: { registration_id: row.id },
      })
    );
    await post(
      event("invoice.paid", {
        id: "in_1",
        amount_paid: 220000,
        customer: null,
        metadata: { registration_id: row.id },
      })
    );

    expect(saved(row.id).stripe_customer_id).toBe("cus_1");
    expect(saved(row.id).stripe_payment_intent_id).toBe("pi_1");
  });
});

/* ------------------------------------------------------------------ *
 * Outcomes that are not payment
 * ------------------------------------------------------------------ */

describe("webhook — failure and expiry", () => {
  it("marks a failed async payment as failed", async () => {
    const row = seed();
    await post(
      event("checkout.session.async_payment_failed", {
        id: "cs_1",
        metadata: { registration_id: row.id },
      })
    );
    expect(saved(row.id).payment_status).toBe("failed");
  });

  it("never walks a confirmed payment backwards", async () => {
    // Events can arrive out of order; a late failure must not unpay real money.
    const row = seed({
      payment_status: "paid",
      amount_paid: 2200,
      payment_recorded_by: "stripe",
    });

    await post(
      event("invoice.payment_failed", { id: "in_1", metadata: { registration_id: row.id } })
    );

    expect(saved(row.id).payment_status).toBe("paid");
    expect(saved(row.id).amount_paid).toBe(2200);
  });

  it("writes off an abandoned checkout as expired, not failed", async () => {
    // Nothing was declined — the payer walked away. Keeping it out of "pending"
    // is what keeps the organisers' chase-up list honest.
    const row = seed({ stripe_checkout_session_id: "cs_abandoned" });

    await post(
      event("checkout.session.expired", {
        id: "cs_abandoned",
        metadata: { registration_id: row.id },
      })
    );

    expect(saved(row.id).payment_status).toBe("expired");
  });

  it("leaves a row alone when a stale session expires after a new attempt", async () => {
    const row = seed({ stripe_checkout_session_id: "cs_second" });

    await post(
      event("checkout.session.expired", {
        id: "cs_first",
        metadata: { registration_id: row.id },
      })
    );

    expect(saved(row.id).payment_status).toBe("pending");
  });

  it("does not write off someone who switched to bank transfer", async () => {
    // They still fully intend to pay; their abandoned card session lapsing must
    // not remove them from the chase-up list.
    const row = seed({
      payment_method: "transfer",
      stripe_checkout_session_id: "cs_abandoned",
    });

    await post(
      event("checkout.session.expired", {
        id: "cs_abandoned",
        metadata: { registration_id: row.id },
      })
    );

    expect(saved(row.id).payment_status).toBe("pending");
  });

  it("does not expire a session that was already paid", async () => {
    const row = seed({
      payment_status: "paid",
      stripe_checkout_session_id: "cs_1",
      payment_recorded_by: "stripe",
    });

    await post(
      event("checkout.session.expired", { id: "cs_1", metadata: { registration_id: row.id } })
    );

    expect(saved(row.id).payment_status).toBe("paid");
  });
});

/* ------------------------------------------------------------------ *
 * The receipt
 * ------------------------------------------------------------------ */

describe("webhook — confirmation email", () => {
  it("emails the payer the amount Stripe actually settled", async () => {
    const row = seed();
    await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 112500,
        metadata: { registration_id: row.id },
      })
    );

    const [entry, amount] = vi.mocked(sendPaidConfirmation).mock.calls[0];
    expect(entry.id).toBe(row.id);
    expect(entry.email).toBe(row.email);
    expect(amount).toBe(1125);
  });

  it("notifies the organisers too, unlike the manual route", async () => {
    const row = seed();
    await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        metadata: { registration_id: row.id },
      })
    );

    const opts = vi.mocked(sendPaidConfirmation).mock.calls[0][2];
    expect(opts?.notifyOrganisers ?? true).toBe(true);
  });

  it("records the payment without re-sending a receipt already claimed", async () => {
    const row = seed({ paid_confirmation_sent_at: "2026-09-02T10:00:00.000Z" });

    const res = await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        metadata: { registration_id: row.id },
      })
    );

    expect(res.status).toBe(200);
    expect(saved(row.id).payment_status).toBe("paid");
    expect(sendPaidConfirmation).not.toHaveBeenCalled();
  });

  it("records the payment before the receipt is attempted", async () => {
    // The webhook relies on lib/email never throwing — a 500 here would have
    // Stripe retry a payment that is already recorded, while the confirmation
    // claim made just before the send would suppress the receipt for good. The
    // guarantee itself is exercised in __tests__/lib/email.test.ts; this pins
    // the ordering the guarantee protects.
    const row = seed();
    let statusWhenEmailed: string | null = null;
    vi.mocked(sendPaidConfirmation).mockImplementationOnce(async () => {
      statusWhenEmailed = saved(row.id).payment_status;
    });

    const res = await post(
      event("checkout.session.completed", {
        id: "cs_1",
        payment_status: "paid",
        amount_total: 220000,
        metadata: { registration_id: row.id },
      })
    );

    expect(res.status).toBe(200);
    expect(statusWhenEmailed).toBe("paid");
  });
});
