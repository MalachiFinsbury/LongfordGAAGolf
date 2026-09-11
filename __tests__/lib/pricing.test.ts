import { describe, expect, it } from "vitest";
import { buildOrderLines } from "@/lib/pricing";
import { CATALOG } from "@/lib/catalog";

const empty = {
  number_of_teams: 0,
  tee_box_count: 0,
  green_count: 0,
  donation_amount: 0,
};

describe("buildOrderLines", () => {
  it("produces nothing for an empty basket", () => {
    expect(buildOrderLines(empty)).toEqual([]);
  });

  it("bills teams by quantity against the catalogue key", () => {
    expect(buildOrderLines({ ...empty, number_of_teams: 3 })).toEqual([
      { lookupKey: CATALOG.team.lookupKey, quantity: 3 },
    ]);
  });

  it("never sends an amount for a fixed-price line", () => {
    // The whole point: the browser contributes quantities, Stripe supplies
    // every unit price. A `unitAmount` here would be a client-set price.
    const lines = buildOrderLines({
      number_of_teams: 1,
      tee_box_count: 2,
      green_count: 1,
      donation_amount: 0,
    });
    for (const line of lines) {
      expect(line.unitAmount).toBeUndefined();
    }
  });

  it("emits one line per product, in catalogue order", () => {
    const lines = buildOrderLines({
      number_of_teams: 1,
      tee_box_count: 2,
      green_count: 3,
      donation_amount: 25,
    });
    expect(lines.map((l) => l.lookupKey)).toEqual([
      CATALOG.team.lookupKey,
      CATALOG.teeBox.lookupKey,
      CATALOG.green.lookupKey,
      CATALOG.donation.lookupKey,
    ]);
    expect(lines.map((l) => l.quantity)).toEqual([1, 2, 3, 1]);
  });

  it("converts the donation to whole cents", () => {
    const [donation] = buildOrderLines({ ...empty, donation_amount: 12.34 });
    expect(donation).toEqual({
      lookupKey: CATALOG.donation.lookupKey,
      quantity: 1,
      unitAmount: 1234,
    });
  });

  it("rounds a fractional cent rather than sending a fraction to Stripe", () => {
    // Stripe rejects a non-integer unit_amount outright, so a donation of
    // €10.005 typed into a step=0.01 box must still produce an integer.
    const [donation] = buildOrderLines({ ...empty, donation_amount: 10.005 });
    expect(Number.isInteger(donation.unitAmount)).toBe(true);
    expect(donation.unitAmount).toBe(1001);
  });

  it("avoids the floating-point trap in naive cent conversion", () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754.
    const [donation] = buildOrderLines({ ...empty, donation_amount: 19.99 });
    expect(donation.unitAmount).toBe(1999);
  });

  it("omits a donation line for zero, and for a missing amount", () => {
    expect(buildOrderLines({ ...empty, number_of_teams: 1, donation_amount: 0 })).toHaveLength(1);
    expect(
      buildOrderLines({
        ...empty,
        number_of_teams: 1,
        donation_amount: undefined as unknown as number,
      })
    ).toHaveLength(1);
  });

  it("omits a donation that rounds down to nothing", () => {
    // A third of a cent is not a chargeable line; sending unit_amount 0 would
    // make Stripe reject the whole session.
    expect(buildOrderLines({ ...empty, donation_amount: 0.004 })).toEqual([]);
  });

  it("skips a product whose quantity is zero", () => {
    const lines = buildOrderLines({
      number_of_teams: 0,
      tee_box_count: 0,
      green_count: 2,
      donation_amount: 0,
    });
    expect(lines).toEqual([{ lookupKey: CATALOG.green.lookupKey, quantity: 2 }]);
  });

  it("only ever references keys that exist in the catalogue", () => {
    const known = new Set<string>(Object.values(CATALOG).map((c) => c.lookupKey));
    const lines = buildOrderLines({
      number_of_teams: 1,
      tee_box_count: 1,
      green_count: 1,
      donation_amount: 1,
    });
    for (const line of lines) {
      expect(known.has(line.lookupKey)).toBe(true);
    }
  });
});
