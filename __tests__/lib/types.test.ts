import { describe, expect, it } from "vitest";
import {
  CARD_PAYMENT_ENABLED,
  DEFAULT_PAYMENT_METHOD,
  INVOICE_PAYMENT_ENABLED,
  MAX_DONATION,
  MAX_GREENS,
  MAX_TEAMS,
  MAX_TEE_BOXES,
  OFFERED_PAYMENT_METHODS,
  PAYMENT_METHODS,
  PLAYERS_PER_TEAM,
  PRICE_PER_GREEN,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  calculateTotal,
  formatEuro,
  isOfferedPaymentMethod,
  isPaymentMethod,
} from "@/lib/types";
import { CLUB_BANK } from "@/lib/types";

describe("calculateTotal", () => {
  it("prices an entry with nothing but teams", () => {
    expect(
      calculateTotal({
        number_of_teams: 2,
        tee_box_count: 0,
        green_count: 0,
        donation_amount: 0,
      })
    ).toBe(2 * PRICE_PER_TEAM);
  });

  it("adds every sponsorship line and the donation", () => {
    expect(
      calculateTotal({
        number_of_teams: 1,
        tee_box_count: 2,
        green_count: 3,
        donation_amount: 150,
      })
    ).toBe(PRICE_PER_TEAM + 2 * PRICE_PER_TEE_BOX + 3 * PRICE_PER_GREEN + 150);
  });

  it("is zero for an entirely empty basket", () => {
    expect(
      calculateTotal({
        number_of_teams: 0,
        tee_box_count: 0,
        green_count: 0,
        donation_amount: 0,
      })
    ).toBe(0);
  });

  it("treats a missing donation as nothing rather than NaN", () => {
    const total = calculateTotal({
      number_of_teams: 1,
      tee_box_count: 0,
      green_count: 0,
      donation_amount: undefined as unknown as number,
    });
    expect(total).toBe(PRICE_PER_TEAM);
    expect(Number.isNaN(total)).toBe(false);
  });

  it("prices a sponsorship-only entry with no team at all", () => {
    expect(
      calculateTotal({
        number_of_teams: 0,
        tee_box_count: 1,
        green_count: 0,
        donation_amount: 0,
      })
    ).toBe(PRICE_PER_TEE_BOX);
  });

  it("agrees with the maximum the form can offer", () => {
    expect(
      calculateTotal({
        number_of_teams: MAX_TEAMS,
        tee_box_count: MAX_TEE_BOXES,
        green_count: MAX_GREENS,
        donation_amount: MAX_DONATION,
      })
    ).toBe(
      MAX_TEAMS * PRICE_PER_TEAM +
        MAX_TEE_BOXES * PRICE_PER_TEE_BOX +
        MAX_GREENS * PRICE_PER_GREEN +
        MAX_DONATION
    );
  });
});

describe("formatEuro", () => {
  /** Intl uses a non-breaking space after the symbol in some locales. */
  const normalise = (s: string) => s.replace(/ /g, " ");

  it("drops the decimals on a whole-euro amount", () => {
    expect(normalise(formatEuro(2200))).toBe("€2,200");
  });

  it("keeps both decimals on a part-euro amount", () => {
    // The bug this guards: a 2-digit minimum of 0 rendered €5,150.50 as
    // "€5,150.5", which is not how money is written — and this same helper
    // prints payment instructions and confirmation emails.
    expect(normalise(formatEuro(5150.5))).toBe("€5,150.50");
  });

  it("renders a sub-euro amount in full", () => {
    expect(normalise(formatEuro(0.05))).toBe("€0.05");
  });

  it("renders zero, and treats a missing amount as zero", () => {
    expect(normalise(formatEuro(0))).toBe("€0");
    expect(normalise(formatEuro(undefined as unknown as number))).toBe("€0");
    expect(normalise(formatEuro(NaN))).toBe("€0");
  });

  it("rounds a third-of-a-cent amount to two digits rather than showing more", () => {
    expect(normalise(formatEuro(10.005))).toMatch(/^€10\.0[01]$/);
  });

  it("handles a negative amount without losing the sign", () => {
    expect(normalise(formatEuro(-100))).toContain("100");
    expect(normalise(formatEuro(-100))).toMatch(/-/);
  });
});

describe("payment method predicates", () => {
  it("recognises every method the app knows about", () => {
    for (const method of PAYMENT_METHODS) {
      expect(isPaymentMethod(method)).toBe(true);
    }
  });

  it("rejects anything that is not a method", () => {
    for (const junk of ["", "cash", "CARD", "transfer ", "__proto__", "constructor"]) {
      expect(isPaymentMethod(junk)).toBe(false);
    }
  });

  it("only offers methods that are switched on", () => {
    expect(OFFERED_PAYMENT_METHODS).not.toHaveLength(0);
    for (const method of OFFERED_PAYMENT_METHODS) {
      if (method === "card") expect(CARD_PAYMENT_ENABLED).toBe(true);
      if (method === "invoice") expect(INVOICE_PAYMENT_ENABLED).toBe(true);
    }
  });

  it("treats a switched-off method as a known method but not an offered one", () => {
    if (!CARD_PAYMENT_ENABLED) {
      expect(isPaymentMethod("card")).toBe(true);
      expect(isOfferedPaymentMethod("card")).toBe(false);
    }
    if (!INVOICE_PAYMENT_ENABLED) {
      expect(isPaymentMethod("invoice")).toBe(true);
      expect(isOfferedPaymentMethod("invoice")).toBe(false);
    }
  });

  it("defaults to a method that is actually on offer", () => {
    // A hard-coded default that stops being offered would leave the form with
    // no radio selected and a submit button labelled for an impossible route.
    expect(OFFERED_PAYMENT_METHODS).toContain(DEFAULT_PAYMENT_METHOD);
  });

  it("always leaves bank transfer available, since it needs no third party", () => {
    expect(OFFERED_PAYMENT_METHODS).toContain("transfer");
  });
});

describe("club bank details", () => {
  it("carries a structurally valid Irish IBAN and BIC", () => {
    // These are printed on the confirmation screen and again in the email; an
    // IBAN that disagrees between the two is a payment that never arrives.
    expect(CLUB_BANK.iban).toMatch(/^IE\d{2}[A-Z0-9]{4}\d{14}$/);
    expect(CLUB_BANK.bic).toMatch(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/);
    expect(CLUB_BANK.accountName.trim()).not.toBe("");
  });
});

describe("form bounds", () => {
  it("keeps every clamp positive, so the form can always offer something", () => {
    expect(MAX_TEAMS).toBeGreaterThan(0);
    expect(MAX_TEE_BOXES).toBeGreaterThan(0);
    expect(MAX_GREENS).toBeGreaterThan(0);
    expect(MAX_DONATION).toBeGreaterThan(0);
    expect(PLAYERS_PER_TEAM).toBe(4);
  });
});
