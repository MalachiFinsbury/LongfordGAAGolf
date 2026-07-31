"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getPublicClient, getAdminClient } from "@/lib/supabase";
import {
  SESSION_COOKIE,
  checkCredentials,
  createSessionToken,
} from "@/lib/auth";
import {
  MAX_TEAMS,
  MAX_TEE_BOXES,
  MAX_GREENS,
  MAX_DONATION,
  PLAYERS_PER_TEAM,
  calculateTotal,
  isPaymentMethod,
  type PaymentMethod,
  type Team,
} from "@/lib/types";
import { buildOrderLines } from "@/lib/pricing";
import { createAndSendInvoice, createCheckoutSession } from "@/lib/payments";
import { checkRateLimit } from "@/lib/rate-limit";

export type SubmitState = {
  ok: boolean;
  error?: string;
  /** Which branch succeeded, so the form knows what to render. */
  method?: PaymentMethod;
  /** Stripe-hosted invoice page, when the payer asked to be invoiced. */
  invoiceUrl?: string;
};

/**
 * Absolute origin for Stripe's return URLs. Prefers an explicit setting, then
 * falls back to the forwarded headers Vercel sets, so preview deployments send
 * payers back to themselves rather than to production.
 */
/**
 * Marks the registration this browser has in flight.
 *
 * httpOnly so page scripts can't read or set it, and only ever consulted for
 * rows that are still unpaid — the worst a forged value could do is overwrite
 * an unpaid stranger's details, and only by guessing a v4 UUID.
 */
const DRAFT_COOKIE = "lgc_draft";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resumableDraftId(): Promise<string | null> {
  const raw = (await cookies()).get(DRAFT_COOKIE)?.value;
  if (!raw || !UUID_RE.test(raw)) return null;

  const { data, error } = await getAdminClient()
    .from("registrations")
    .select("id")
    .eq("id", raw)
    .eq("payment_status", "pending")
    // An invoice already went out for this row; re-using it would email a
    // second one. Start fresh instead.
    .is("stripe_invoice_id", null)
    .maybeSingle();

  if (error) {
    console.error("[registration] draft lookup failed", error.message);
    return null;
  }
  return data?.id ?? null;
}

async function rememberDraft(id: string): Promise<void> {
  (await cookies()).set(DRAFT_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax so it survives the top-level navigation back from Stripe.
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 6,
  });
}

async function forgetDraft(): Promise<void> {
  (await cookies()).delete(DRAFT_COOKIE);
}

async function getOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (!host) throw new Error("Could not determine the site origin.");
  return `${proto}://${host}`;
}

function toInt(value: FormDataEntryValue | null): number {
  const n = parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toNum(value: FormDataEntryValue | null): number {
  const n = parseFloat(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Trimmed, and bounded so an oversized field can't reach Stripe or the DB. */
function str(value: FormDataEntryValue | null, maxLength = 200): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function submitRegistration(
  _prev: SubmitState,
  formData: FormData
): Promise<SubmitState> {
  // This endpoint is public and, on the invoice path, makes Stripe send email
  // to an address the caller chose. Bound it before doing any work.
  const { allowed } = await checkRateLimit("registration");
  if (!allowed) {
    return {
      ok: false,
      error:
        "Too many registrations from this connection. Please wait a little " +
        "and try again, or contact the organisers directly.",
    };
  }

  const name = str(formData.get("name"));
  const mobile = str(formData.get("mobile"), 40);
  const email = str(formData.get("email"), 254);

  if (!name || !mobile || !email) {
    return { ok: false, error: "Please fill in your name, mobile and email." };
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  const number_of_teams = Math.min(toInt(formData.get("number_of_teams")), MAX_TEAMS);

  // Collect team players for the number of teams selected.
  const teams: Team[] = [];
  for (let t = 1; t <= number_of_teams; t++) {
    const players = [];
    for (let p = 1; p <= PLAYERS_PER_TEAM; p++) {
      players.push({
        name: str(formData.get(`team_${t}_player_${p}_name`)),
        handicap: str(formData.get(`team_${t}_player_${p}_handicap`)),
      });
    }
    teams.push({ players });
  }

  // At least one player name is required if any team was selected.
  if (number_of_teams > 0) {
    const hasCaptain = teams[0].players.some((p) => p.name);
    if (!hasCaptain) {
      return {
        ok: false,
        error: "Please enter at least the first player's name for Team 1.",
      };
    }
  }

  // Clamped, not just parsed: these come straight from the browser and feed
  // the amount charged.
  const tee_box_count = Math.min(toInt(formData.get("tee_box_count")), MAX_TEE_BOXES);
  const green_count = Math.min(toInt(formData.get("green_count")), MAX_GREENS);
  const donation_amount = Math.min(toNum(formData.get("donation_amount")), MAX_DONATION);
  const sponsor_raffle = formData.get("sponsor_raffle") === "on";
  const raffle_prize = sponsor_raffle ? str(formData.get("raffle_prize"), 1000) : "";

  const rawMethod = str(formData.get("payment_method"));
  const payment_method: PaymentMethod = isPaymentMethod(rawMethod) ? rawMethod : "transfer";

  const address = str(formData.get("address")) || null;
  const total_amount = calculateTotal({
    number_of_teams,
    tee_box_count,
    green_count,
    donation_amount,
  });

  // Every unit price is resolved from the Stripe catalogue server-side; the
  // form only ever contributes quantities and the donation amount.
  const orderLines = buildOrderLines({
    number_of_teams,
    tee_box_count,
    green_count,
    donation_amount,
  });

  if (payment_method !== "transfer" && orderLines.length === 0) {
    return {
      ok: false,
      error: "There is nothing to pay for — select at least one team or sponsorship.",
    };
  }

  const entry = {
    name,
    company_or_club: str(formData.get("company_or_club")) || null,
    address,
    mobile,
    email,
    number_of_teams,
    teams,
    tee_box_count,
    green_count,
    donation_amount,
    sponsor_raffle,
    raffle_prize: raffle_prize || null,
    total_amount,
    payment_method,
  };

  // If this browser abandoned a card checkout and came back, update that same
  // row rather than leaving a trail of duplicate "awaiting payment" entries in
  // the organisers' dashboard.
  const resumedId = await resumableDraftId();
  let registrationId: string;

  try {
    if (resumedId) {
      registrationId = resumedId;
      const { error } = await getAdminClient()
        .from("registrations")
        .update(entry)
        .eq("id", resumedId)
        // Re-checked here, not just when reading the cookie, so a row that got
        // paid in the meantime can never be rewritten.
        .eq("payment_status", "pending")
        .is("stripe_invoice_id", null);
      if (error) throw error;
    } else {
      // Generated here rather than read back from the insert: the anon key has
      // insert-only access under RLS, so it cannot SELECT the row it wrote.
      registrationId = crypto.randomUUID();
      const { error } = await getPublicClient()
        .from("registrations")
        .insert({ id: registrationId, ...entry, payment_status: "pending" });
      if (error) throw error;
    }
  } catch (e) {
    // Logged in full, but not echoed back — raw Postgres errors disclose table
    // and column names to anyone probing the form.
    console.error("[registration] save failed", e);
    return {
      ok: false,
      error: "Sorry, we couldn't save your registration. Please try again.",
    };
  }

  const payer = { registrationId, name, email, mobile, address };

  if (payment_method === "card") {
    let checkoutUrl: string;
    try {
      const session = await createCheckoutSession(payer, orderLines, await getOrigin());
      if (!session.url) throw new Error("Stripe did not return a checkout URL.");
      checkoutUrl = session.url;

      await getAdminClient()
        .from("registrations")
        .update({ stripe_checkout_session_id: session.id })
        .eq("id", registrationId);

      // Set before leaving for Stripe: if they hit Back, the next submit
      // updates this row instead of creating a second one.
      await rememberDraft(registrationId);
    } catch (e) {
      console.error("[stripe] checkout session failed", e);
      return {
        ok: false,
        error:
          "Your details were saved, but we couldn't start the card payment. " +
          "Please try again, or choose bank transfer.",
      };
    }
    // Must sit outside the try: redirect() signals by throwing, and catching
    // it here would turn a successful redirect into an error message.
    redirect(checkoutUrl);
  }

  if (payment_method === "invoice") {
    try {
      const invoice = await createAndSendInvoice(payer, orderLines);

      await getAdminClient()
        .from("registrations")
        .update({
          stripe_customer_id:
            typeof invoice.customer === "string"
              ? invoice.customer
              : (invoice.customer?.id ?? null),
          stripe_invoice_id: invoice.id ?? null,
          stripe_invoice_url: invoice.hosted_invoice_url ?? null,
          stripe_invoice_number: invoice.number ?? null,
        })
        .eq("id", registrationId);

      // The entry is complete — a later submit should be a new registration.
      await forgetDraft();

      return {
        ok: true,
        method: "invoice",
        invoiceUrl: invoice.hosted_invoice_url ?? undefined,
      };
    } catch (e) {
      console.error("[stripe] invoice creation failed", e);
      return {
        ok: false,
        error:
          "Your details were saved, but we couldn't raise the invoice. " +
          "Please try again, or choose bank transfer.",
      };
    }
  }

  await forgetDraft();
  return { ok: true, method: "transfer" };
}

export type LoginState = { error?: string };

export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").slice(0, 200);
  const password = String(formData.get("password") ?? "").slice(0, 200);

  // The dashboard holds every registrant's contact details behind a single
  // shared password, so cap how fast it can be guessed.
  const { allowed } = await checkRateLimit("admin-login");
  if (!allowed) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  if (!checkCredentials(username, password)) {
    return { error: "Invalid username or password." };
  }

  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8, // 8 hours
  });

  redirect("/admin");
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/admin/login");
}
