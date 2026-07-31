import { CATALOG } from "./catalog.ts";

/**
 * A single billable line, expressed in terms of the catalogue rather than raw
 * money. Both the Checkout and Invoicing paths derive their line items from
 * this, so the two can never drift apart on price.
 */
export type OrderLine = {
  lookupKey: string;
  quantity: number;
  /**
   * Cents. Only set for variable-amount lines (donations); fixed lines take
   * their amount from the Stripe Price so the server can't be talked into a
   * different number by the client.
   */
  unitAmount?: number;
};

export type OrderInput = {
  number_of_teams: number;
  tee_box_count: number;
  green_count: number;
  donation_amount: number;
};

/**
 * Turn a validated registration into billable lines.
 *
 * Note what is *absent*: the client never supplies an amount. Quantities come
 * from the form, but every unit price is looked up server-side from Stripe.
 */
export function buildOrderLines(input: OrderInput): OrderLine[] {
  const lines: OrderLine[] = [];

  if (input.number_of_teams > 0) {
    lines.push({ lookupKey: CATALOG.team.lookupKey, quantity: input.number_of_teams });
  }
  if (input.tee_box_count > 0) {
    lines.push({ lookupKey: CATALOG.teeBox.lookupKey, quantity: input.tee_box_count });
  }
  if (input.green_count > 0) {
    lines.push({ lookupKey: CATALOG.green.lookupKey, quantity: input.green_count });
  }

  const donationCents = Math.round((input.donation_amount || 0) * 100);
  if (donationCents > 0) {
    lines.push({
      lookupKey: CATALOG.donation.lookupKey,
      quantity: 1,
      unitAmount: donationCents,
    });
  }

  return lines;
}
