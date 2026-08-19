export const PRICE_PER_TEAM = 2200;
export const PRICE_PER_TEE_BOX = 500;
export const PRICE_PER_GREEN = 500;
export const MAX_TEAMS = 5;
export const PLAYERS_PER_TEAM = 4;

// Upper bounds on anything the browser can influence. These drive both the
// dropdown options and the server-side clamp, so a crafted POST asking for
// 999,999 tee boxes can't generate an absurd invoice.
export const MAX_TEE_BOXES = 5;
export const MAX_GREENS = 5;
export const MAX_DONATION = 50_000;

/**
 * The club's account for manual bank transfers.
 *
 * Single source of truth: these appear on the confirmation screen and again in
 * the confirmation email, and an IBAN that disagrees between the two is a
 * payment that never arrives.
 */
export const CLUB_BANK = {
  accountName: "Longford County Board GAA",
  iban: "IE31IPBS99073152079039",
  bic: "IPBSIE2D",
} as const;

export type Player = {
  name: string;
  handicap: string;
};

export type Team = {
  players: Player[];
};

/**
 * sessionStorage slot holding a half-finished registration, so that leaving
 * for Stripe Checkout and pressing Back doesn't lose everything typed.
 */
export const REGISTRATION_DRAFT_KEY = "lgc:registration-draft:v1";

export type PaymentMethod = "card" | "invoice" | "transfer";
export type PaymentStatus = "pending" | "paid" | "failed" | "expired";

export const PAYMENT_METHODS: PaymentMethod[] = ["card", "invoice", "transfer"];

/**
 * Whether "send me an invoice" is offered to payers.
 *
 * Hidden rather than deleted: the Stripe invoicing path in lib/payments.ts is
 * intact, so putting it back is this one constant. The form and the server
 * action both read it, because a hidden radio button is not a control — the
 * form field is still there to be posted by hand, and honouring it would let
 * anyone make the club's live Stripe account email a formal invoice to an
 * address of their choosing.
 */
export const INVOICE_PAYMENT_ENABLED = false;

/** The subset of methods a payer may actually choose right now. */
export const OFFERED_PAYMENT_METHODS: PaymentMethod[] = PAYMENT_METHODS.filter(
  (m) => m !== "invoice" || INVOICE_PAYMENT_ENABLED
);

export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as string[]).includes(value);
}

export function isOfferedPaymentMethod(value: string): value is PaymentMethod {
  return (OFFERED_PAYMENT_METHODS as string[]).includes(value);
}

export type Registration = {
  id: string;
  created_at: string;
  name: string;
  company_or_club: string | null;
  address: string | null;
  mobile: string;
  email: string;
  number_of_teams: number;
  teams: Team[];
  tee_box_count: number;
  green_count: number;
  donation_amount: number;
  sponsor_raffle: boolean;
  raffle_prize: string | null;
  total_amount: number;

  // Payment — see supabase/002-stripe.sql
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  amount_paid: number;
  paid_at: string | null;
  /** Set once, atomically, so two Stripe events can't both email a receipt. */
  paid_confirmation_sent_at: string | null;
  stripe_customer_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_invoice_url: string | null;
  stripe_invoice_number: string | null;
};

export function calculateTotal(input: {
  number_of_teams: number;
  tee_box_count: number;
  green_count: number;
  donation_amount: number;
}): number {
  return (
    input.number_of_teams * PRICE_PER_TEAM +
    input.tee_box_count * PRICE_PER_TEE_BOX +
    input.green_count * PRICE_PER_GREEN +
    (input.donation_amount || 0)
  );
}

export function formatEuro(amount: number): string {
  const value = amount || 0;
  // Whole euros read better on a price list without a trailing ".00", but a
  // part-euro amount must never render as "€5,150.5" — that is not how money is
  // written, and this same helper prints the figure on payment instructions,
  // confirmation emails and the organisers' totals.
  const digits = Number.isInteger(value) ? 0 : 2;
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
