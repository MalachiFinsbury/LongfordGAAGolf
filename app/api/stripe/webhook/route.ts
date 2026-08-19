import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { getAdminClient } from "@/lib/supabase";
import { sendPaidConfirmation } from "@/lib/email";
import type { Registration } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook receiver.
 *
 * This is the only place the app is allowed to conclude that a registration
 * has been paid. Success redirects are not proof of payment — a payer can
 * close the tab before returning, and the success URL can be visited by hand.
 */
export async function POST(req: Request) {
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signingSecret) {
    console.error("[stripe] STRIPE_WEBHOOK_SECRET is not set");
    return new Response("Webhook not configured", { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // The signature covers the exact bytes Stripe sent, so read the raw body —
  // parsing it as JSON first would invalidate the comparison.
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(
      payload,
      signature,
      signingSecret
    );
  } catch (e) {
    console.error("[stripe] signature verification failed", e);
    return new Response("Invalid signature", { status: 400 });
  }

  const supabase = getAdminClient();

  // Claim the event id before doing any work. The primary key makes this
  // atomic, so a redelivery of something we already processed cannot
  // double-count a payment.
  const { error: claimError } = await supabase
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });

  if (claimError) {
    if (claimError.code === "23505") {
      return Response.json({ received: true, duplicate: true });
    }
    console.error("[stripe] could not claim event", claimError);
    return new Response("Could not record event", { status: 500 });
  }

  try {
    await handleEvent(event);
  } catch (e) {
    console.error(`[stripe] handler failed for ${event.type} (${event.id})`, e);
    // Release the claim so Stripe's retry gets a genuine second attempt
    // instead of being waved through as a duplicate.
    await supabase.from("stripe_events").delete().eq("id", event.id);
    return new Response("Handler error", { status: 500 });
  }

  return Response.json({ received: true });
}

type StripeRef = string | { id: string } | null | undefined;

/** Stripe returns either a bare id or an expanded object depending on context. */
function idOf(ref: StripeRef): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function toEuro(cents: number | null | undefined): number {
  return (cents ?? 0) / 100;
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;

      // Delayed payment methods complete the session while still unpaid;
      // the async_payment_* event is the one that settles it.
      if (session.payment_status === "unpaid") return;

      await markPaid(
        session.metadata?.registration_id ?? session.client_reference_id,
        {
          amount_paid: toEuro(session.amount_total),
          stripe_checkout_session_id: session.id,
          stripe_customer_id: idOf(session.customer),
          stripe_payment_intent_id: idOf(session.payment_intent),
          stripe_invoice_id: idOf(session.invoice),
        }
      );
      return;
    }

    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      await markFailed(
        session.metadata?.registration_id ?? session.client_reference_id
      );
      return;
    }

    case "checkout.session.expired": {
      const session = event.data.object;
      await markExpired(
        session.metadata?.registration_id ?? session.client_reference_id,
        session.id
      );
      return;
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      await markPaid(invoice.metadata?.registration_id, {
        amount_paid: toEuro(invoice.amount_paid),
        stripe_customer_id: idOf(invoice.customer),
        stripe_invoice_id: invoice.id ?? null,
        stripe_invoice_number: invoice.number ?? null,
        stripe_invoice_url: invoice.hosted_invoice_url ?? null,
      });
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      await markFailed(invoice.metadata?.registration_id);
      return;
    }

    default:
      // Everything else is subscribed-to-but-uninteresting; acknowledging it
      // keeps Stripe from retrying.
      return;
  }
}

type PaidPatch = {
  amount_paid: number;
  stripe_checkout_session_id?: string | null;
  stripe_customer_id?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_invoice_id?: string | null;
  stripe_invoice_number?: string | null;
  stripe_invoice_url?: string | null;
};

async function markPaid(
  registrationId: string | null | undefined,
  patch: PaidPatch
): Promise<void> {
  if (!registrationId) {
    console.warn("[stripe] paid event carried no registration_id — skipping");
    return;
  }

  // Strip nulls so a later event can't blank out an id an earlier one set.
  const fields = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)
  );

  const { error } = await getAdminClient()
    .from("registrations")
    .update({
      ...fields,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      // Stamped so the dashboard can tell a settled payment apart from one an
      // organiser recorded by hand, and so a manual override can refuse to
      // overwrite this one.
      payment_recorded_by: "stripe",
    })
    .eq("id", registrationId);

  if (error) throw new Error(`Supabase update failed: ${error.message}`);

  await sendPaidConfirmationOnce(registrationId);
}

/**
 * Emails the payer their confirmation, at most once per registration.
 *
 * A card checkout with `invoice_creation` enabled produces *two* paid events —
 * `checkout.session.completed` and `invoice.paid` — and both legitimately land
 * here. The `stripe_events` ledger dedupes redeliveries of the *same* event but
 * cannot help across two different ones, so the claim is made in Postgres: the
 * `is null` predicate means exactly one caller gets a row back, whichever
 * arrives first, even if they arrive together.
 */
async function sendPaidConfirmationOnce(registrationId: string): Promise<void> {
  const { data, error } = await getAdminClient()
    .from("registrations")
    .update({ paid_confirmation_sent_at: new Date().toISOString() })
    .eq("id", registrationId)
    .is("paid_confirmation_sent_at", null)
    .select("*")
    .maybeSingle();

  if (error) {
    // Not fatal. The payment is recorded, which is the part that matters —
    // failing here would return 500 and have Stripe retry a settled payment.
    console.error("[stripe] could not claim confirmation email", error.message);
    return;
  }
  if (!data) return; // Another event already sent it.

  const row = data as Registration;
  await sendPaidConfirmation(row, Number(row.amount_paid));
}

/**
 * A card checkout that was opened and never finished.
 *
 * Recorded distinctly from "pending" so the organisers' chase-up list stays a
 * list of people who actually intend to pay. It is deliberately not "failed":
 * nothing was declined, the payer simply walked away.
 */
async function markExpired(
  registrationId: string | null | undefined,
  sessionId: string
): Promise<void> {
  if (!registrationId) {
    console.warn("[stripe] expiry event carried no registration_id — skipping");
    return;
  }

  const { error } = await getAdminClient()
    .from("registrations")
    .update({ payment_status: "expired" })
    .eq("id", registrationId)
    // Every one of these narrows the blast radius of a late-arriving expiry.
    // A row that already reached a real outcome keeps it; a payer who came
    // back and started a *new* checkout has a different session id here; and
    // one who switched to bank transfer still fully intends to pay, so their
    // row must not be written off when the abandoned card session lapses.
    .eq("payment_status", "pending")
    .eq("stripe_checkout_session_id", sessionId)
    .eq("payment_method", "card");

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

async function markFailed(
  registrationId: string | null | undefined
): Promise<void> {
  if (!registrationId) {
    console.warn("[stripe] failure event carried no registration_id — skipping");
    return;
  }

  const { error } = await getAdminClient()
    .from("registrations")
    .update({ payment_status: "failed" })
    .eq("id", registrationId)
    // Never walk a confirmed payment backwards, whatever order events arrive in.
    .neq("payment_status", "paid");

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}
