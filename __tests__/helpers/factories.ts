import type { Registration, Team } from "@/lib/types";

let counter = 0;

/** A syntactically valid v4-shaped UUID, distinct per call. */
export function uuid(seed?: number): string {
  const n = (seed ?? ++counter).toString(16).padStart(12, "0");
  return `11111111-2222-4333-8444-${n.slice(-12)}`;
}

export function team(names: string[], handicaps: string[] = []): Team {
  return {
    players: names.map((name, i) => ({ name, handicap: handicaps[i] ?? "" })),
  };
}

/**
 * A complete registration row. Overrides are shallow-merged, so a test states
 * only the columns its assertion turns on.
 */
export function registration(overrides: Partial<Registration> = {}): Registration {
  const id = overrides.id ?? uuid();
  return {
    id,
    created_at: "2026-09-01T10:00:00.000Z",
    name: "Máire Ní Bhriain",
    company_or_club: "Longford Slashers",
    address: "1 Main Street, Longford",
    mobile: "0871234567",
    email: "maire@example.ie",
    number_of_teams: 1,
    teams: [team(["Máire Ní Bhriain", "Seán Ó Conaill", "", ""], ["12", "8"])],
    tee_box_count: 0,
    green_count: 0,
    donation_amount: 0,
    sponsor_raffle: false,
    raffle_prize: null,
    total_amount: 2200,
    payment_method: "transfer",
    payment_status: "pending",
    amount_paid: 0,
    paid_at: null,
    paid_confirmation_sent_at: null,
    payment_recorded_by: null,
    payment_note: null,
    payer_claimed_paid_at: null,
    stripe_customer_id: null,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    stripe_invoice_id: null,
    stripe_invoice_url: null,
    stripe_invoice_number: null,
    ...overrides,
  };
}

/** Form data for a valid, minimal registration; overrides replace or add fields. */
export function registrationForm(
  overrides: Record<string, string> = {}
): FormData {
  const base: Record<string, string> = {
    name: "Máire Ní Bhriain",
    mobile: "0871234567",
    email: "maire@example.ie",
    number_of_teams: "1",
    team_1_player_1_name: "Máire Ní Bhriain",
    team_1_player_1_handicap: "12",
    tee_box_count: "0",
    green_count: "0",
    donation_amount: "0",
    payment_method: "transfer",
  };

  const merged = { ...base, ...overrides };
  const form = new FormData();
  for (const [key, value] of Object.entries(merged)) {
    // An explicit empty string still posts; `undefined` removes the field, which
    // is how a test says "this input was never rendered".
    if (value === undefined) continue;
    form.set(key, value);
  }
  return form;
}
