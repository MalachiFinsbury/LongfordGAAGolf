// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CLUB_BANK,
  DEFAULT_PAYMENT_METHOD,
  MAX_DONATION,
  MAX_TEAMS,
  OFFERED_PAYMENT_METHODS,
  PLAYERS_PER_TEAM,
  PRICE_PER_GREEN,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  REGISTRATION_DRAFT_KEY,
} from "@/lib/types";
import type { SubmitState } from "@/app/actions";

/** What the mocked server action will return for the next submission. */
let actionResult: SubmitState = { ok: true, method: "transfer" };
const submitSpy = vi.fn();

vi.mock("@/app/actions", () => ({
  submitRegistration: async (_prev: SubmitState, formData: FormData) => {
    submitSpy(Object.fromEntries(formData.entries()));
    return actionResult;
  },
}));

const RegistrationForm = (await import("@/app/RegistrationForm")).default;

const user = () => userEvent.setup();

/** The running total, which is the figure the payer is agreeing to. */
function total(): string {
  return screen.getByText(/Total amount due/i).parentElement!.textContent!;
}

function draft() {
  const raw = sessionStorage.getItem(REGISTRATION_DRAFT_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function fillRequired(u: ReturnType<typeof user>) {
  await u.type(screen.getByLabelText(/^Name/), "Máire Ní Bhriain");
  await u.type(screen.getByLabelText(/^Mobile/), "0871234567");
  await u.type(screen.getByLabelText(/^Email/), "maire@example.ie");
  // Team 1's captain — `getAll` because a multi-team form has one per team.
  await u.type(screen.getAllByLabelText(/Player 1 name/)[0], "Máire Ní Bhriain");
}

beforeEach(() => {
  sessionStorage.clear();
  actionResult = { ok: true, method: "transfer" };
  submitSpy.mockClear();
});

afterEach(cleanup);

describe("RegistrationForm — the entry itself", () => {
  it("asks for the details the club cannot do without", () => {
    render(<RegistrationForm />);

    for (const label of [/^Name/, /^Mobile/, /^Email/]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).required, String(label)).toBe(
        true
      );
    }
    expect((screen.getByLabelText(/Company or club/) as HTMLInputElement).required).toBe(false);
    expect((screen.getByLabelText(/Address/) as HTMLInputElement).required).toBe(false);
  });

  it("starts on one team and prices it", () => {
    render(<RegistrationForm />);
    expect(total()).toContain("€2,200");
  });

  it("offers entering with no team at all", () => {
    // A tee-box sponsor, a donor, or someone offering only a raffle prize had
    // no way through this form without buying a team entry they did not want.
    render(<RegistrationForm />);
    const select = screen.getByLabelText(/Number of teams/) as HTMLSelectElement;

    expect(
      within(select).getByRole("option", { name: /No team — sponsorship or donation only/ })
    ).toBeDefined();
  });

  it("offers no more teams than the server will accept", () => {
    render(<RegistrationForm />);
    const select = screen.getByLabelText(/Number of teams/);
    // Every team option, plus the "no team" one.
    expect(within(select).getAllByRole("option")).toHaveLength(MAX_TEAMS + 1);
  });

  it("shows a player block per team, four players each", async () => {
    const u = user();
    render(<RegistrationForm />);

    await u.selectOptions(screen.getByLabelText(/Number of teams/), "3");

    expect(screen.getAllByRole("heading", { name: /Team \d$/ })).toHaveLength(3);
    expect(screen.getAllByLabelText(/Player \d name/)).toHaveLength(3 * PLAYERS_PER_TEAM);
    expect(screen.getAllByLabelText(/Handicap/)).toHaveLength(3 * PLAYERS_PER_TEAM);
  });

  it("asks for no players at all when no team was selected", async () => {
    const u = user();
    render(<RegistrationForm />);

    await u.selectOptions(screen.getByLabelText(/Number of teams/), "0");
    expect(screen.queryByLabelText(/Player 1 name/)).toBeNull();
  });

  it("requires only the first captain's name", async () => {
    const u = user();
    render(<RegistrationForm />);
    await u.selectOptions(screen.getByLabelText(/Number of teams/), "2");

    const names = screen.getAllByLabelText(/Player \d name/) as HTMLInputElement[];
    expect(names[0].required).toBe(true);
    expect(names.slice(1).some((input) => input.required)).toBe(false);
  });

  it("reveals the prize box only once a raffle prize is offered", async () => {
    const u = user();
    render(<RegistrationForm />);

    expect(screen.queryByLabelText(/Raffle prize/)).toBeNull();
    await u.click(screen.getByLabelText(/sponsor a raffle prize/i));
    expect(screen.getByLabelText(/Raffle prize/)).toBeDefined();
  });
});

describe("RegistrationForm — the running total", () => {
  it("follows the number of teams", async () => {
    const u = user();
    render(<RegistrationForm />);

    await u.selectOptions(screen.getByLabelText(/Number of teams/), "3");
    expect(total()).toContain(`€${(3 * PRICE_PER_TEAM).toLocaleString("en-IE")}`);
  });

  it("adds sponsorships and the donation", async () => {
    const u = user();
    render(<RegistrationForm />);

    await u.selectOptions(screen.getByLabelText(/Tee box sponsorship/), "2");
    await u.selectOptions(screen.getByLabelText(/Green sponsorship/), "1");
    await u.type(screen.getByLabelText(/Donation amount/), "50");

    const expected =
      PRICE_PER_TEAM + 2 * PRICE_PER_TEE_BOX + PRICE_PER_GREEN + 50;
    expect(total()).toContain(expected.toLocaleString("en-IE"));
  });

  it("falls to nothing for a raffle-prize-only entry", async () => {
    const u = user();
    render(<RegistrationForm />);

    await u.selectOptions(screen.getByLabelText(/Number of teams/), "0");
    await u.click(screen.getByLabelText(/sponsor a raffle prize/i));

    expect(total()).toContain("€0");
  });

  it("will not let a donation exceed what the server accepts", async () => {
    const u = user();
    render(<RegistrationForm />);
    const donation = screen.getByLabelText(/Donation amount/) as HTMLInputElement;

    expect(donation.max).toBe(String(MAX_DONATION));
    await u.type(donation, "999999");
    expect(Number(donation.value)).toBeLessThanOrEqual(MAX_DONATION);
  });
});

describe("RegistrationForm — how to pay", () => {
  it("states the single method rather than asking a question with one answer", () => {
    render(<RegistrationForm />);

    if (OFFERED_PAYMENT_METHODS.length === 1) {
      expect(screen.getByRole("heading", { name: /How to pay/ })).toBeDefined();
      expect(screen.queryByRole("radio")).toBeNull();
    } else {
      expect(screen.getByRole("heading", { name: /How would you like to pay/ })).toBeDefined();
      expect(screen.getAllByRole("radio")).toHaveLength(OFFERED_PAYMENT_METHODS.length);
    }
  });

  it("still posts the method, so the server never has to infer it", async () => {
    const u = user();
    render(<RegistrationForm />);
    await fillRequired(u);
    await u.click(screen.getByRole("button", { name: /Submit registration/i }));

    await waitFor(() => expect(submitSpy).toHaveBeenCalled());
    expect(submitSpy.mock.calls[0][0].payment_method).toBe(DEFAULT_PAYMENT_METHOD);
  });

  it("never offers a method that is switched off", () => {
    render(<RegistrationForm />);
    const offered = new Set(OFFERED_PAYMENT_METHODS);

    if (!offered.has("card")) expect(screen.queryByText(/Pay now by card/)).toBeNull();
    if (!offered.has("invoice")) expect(screen.queryByText(/Send me an invoice/)).toBeNull();
  });

  it("labels the submit button for the route the payer is actually taking", () => {
    render(<RegistrationForm />);
    const labels: Record<string, RegExp> = {
      card: /Continue to secure payment/,
      invoice: /email me an invoice/,
      transfer: /Submit registration/,
    };
    expect(
      screen.getByRole("button", { name: labels[DEFAULT_PAYMENT_METHOD] })
    ).toBeDefined();
  });
});

describe("RegistrationForm — submitting", () => {
  it("posts everything the payer typed", async () => {
    const u = user();
    render(<RegistrationForm />);

    await fillRequired(u);
    await u.type(screen.getByLabelText(/Company or club/), "Longford Slashers");
    await u.selectOptions(screen.getByLabelText(/Tee box sponsorship/), "1");
    await u.click(screen.getByRole("button", { name: /Submit/i }));

    await waitFor(() => expect(submitSpy).toHaveBeenCalled());
    const posted = submitSpy.mock.calls[0][0];

    expect(posted.name).toBe("Máire Ní Bhriain");
    expect(posted.email).toBe("maire@example.ie");
    expect(posted.company_or_club).toBe("Longford Slashers");
    expect(posted.tee_box_count).toBe("1");
    expect(posted.team_1_player_1_name).toBe("Máire Ní Bhriain");
  });

  it("shows the club's bank details once the entry is in", async () => {
    const u = user();
    render(<RegistrationForm />);
    await fillRequired(u);
    await u.click(screen.getByRole("button", { name: /Submit/i }));

    expect(await screen.findByText(/Thank you!/)).toBeDefined();
    expect(screen.getByText(CLUB_BANK.iban)).toBeDefined();
    expect(screen.getByText(CLUB_BANK.bic)).toBeDefined();
    expect(screen.getByText(CLUB_BANK.accountName)).toBeDefined();
  });

  it("offers to copy each account detail, since they get retyped into a banking app", async () => {
    const u = user();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<RegistrationForm />);
    await fillRequired(u);
    await u.click(screen.getByRole("button", { name: /Submit/i }));
    await screen.findByText(/Thank you!/);

    await u.click(screen.getAllByRole("button", { name: /Copy/ })[1]);
    expect(writeText).toHaveBeenCalledWith(CLUB_BANK.iban);
  });

  it("shows the invoice link when one was raised", async () => {
    actionResult = {
      ok: true,
      method: "invoice",
      invoiceUrl: "https://invoice.stripe.com/i/test",
    };
    const u = user();
    render(<RegistrationForm />);
    await fillRequired(u);
    await u.click(screen.getByRole("button", { name: /Submit/i }));

    const link = await screen.findByRole("link", { name: /View and pay your invoice/ });
    expect(link.getAttribute("href")).toBe("https://invoice.stripe.com/i/test");
  });

  it("reports the server's error rather than a blank failure", async () => {
    actionResult = { ok: false, error: "Too many registrations from this connection." };
    const u = user();
    render(<RegistrationForm />);
    await fillRequired(u);
    await u.click(screen.getByRole("button", { name: /Submit/i }));

    expect(await screen.findByText(/Too many registrations/)).toBeDefined();
    // Still the form, not the confirmation screen.
    expect(screen.queryByText(/Thank you!/)).toBeNull();
  });

  /*
   * Deliberately not asserted here: what happens to the *values* in the
   * uncontrolled text inputs after a rejected submission. React 19 resets a
   * form once its action settles, but under jsdom the reset lands
   * non-deterministically relative to the re-render, so an assertion either way
   * is flaky. What matters to the payer — that the error is shown and the typed
   * details are still recoverable from the draft — is covered above and below.
   */
  it("still holds the typed details in the draft after a rejected submission", async () => {
    // Which is what makes the loss recoverable: the values are gone from the
    // inputs, but a reload restores them from here.
    actionResult = { ok: false, error: "Sorry, we couldn't save your registration." };
    const u = user();
    render(<RegistrationForm />);

    await fillRequired(u);
    await u.click(screen.getByRole("button", { name: /Submit/i }));
    await screen.findByText(/couldn't save/);

    expect(draft().fields.name).toBe("Máire Ní Bhriain");
    expect(draft().fields.email).toBe("maire@example.ie");
  });
});

describe("RegistrationForm — the saved draft", () => {
  it("keeps what was typed while the payer is away paying", async () => {
    const u = user();
    render(<RegistrationForm />);
    await u.type(screen.getByLabelText(/^Name/), "Máire");
    await u.selectOptions(screen.getByLabelText(/Number of teams/), "2");

    await waitFor(() => expect(draft()).not.toBeNull());
    expect(draft().fields.name).toBe("Máire");
    expect(draft().numTeams).toBe(2);
  });

  it("restores it on the way back", async () => {
    sessionStorage.setItem(
      REGISTRATION_DRAFT_KEY,
      JSON.stringify({
        numTeams: 2,
        teeBox: 1,
        green: 0,
        donation: 25,
        sponsorRaffle: true,
        payMethod: DEFAULT_PAYMENT_METHOD,
        fields: {
          name: "Máire Ní Bhriain",
          email: "maire@example.ie",
          team_2_player_1_name: "Seán",
          raffle_prize: "A hamper",
        },
      })
    );

    render(<RegistrationForm />);

    await waitFor(() =>
      expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
        "Máire Ní Bhriain"
      )
    );
    expect((screen.getByLabelText(/Number of teams/) as HTMLSelectElement).value).toBe("2");
    expect((screen.getByLabelText(/Tee box sponsorship/) as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText(/Donation amount/) as HTMLInputElement).value).toBe("25");
    // The player rows only exist because numTeams was restored first.
    expect(
      (screen.getAllByLabelText(/Player 1 name/)[1] as HTMLInputElement).value
    ).toBe("Seán");
    expect((screen.getByLabelText(/Raffle prize/) as HTMLTextAreaElement).value).toBe(
      "A hamper"
    );
  });

  it("restores a deliberate zero rather than reinstating the default team", async () => {
    // Stored as 0, and a falsy test would silently put one team back — the
    // sponsorship-only payer would be charged €2,200 they never asked for.
    sessionStorage.setItem(
      REGISTRATION_DRAFT_KEY,
      JSON.stringify({ numTeams: 0, teeBox: 1, green: 0, donation: 0, fields: {} })
    );

    render(<RegistrationForm />);

    await waitFor(() =>
      expect((screen.getByLabelText(/Number of teams/) as HTMLSelectElement).value).toBe("0")
    );
    expect(screen.queryByLabelText(/Player 1 name/)).toBeNull();
  });

  it("ignores a saved method that is no longer offered", async () => {
    // Otherwise the payer comes back to a form with no option selected and a
    // submit button labelled for a route they cannot take.
    sessionStorage.setItem(
      REGISTRATION_DRAFT_KEY,
      JSON.stringify({ numTeams: 1, payMethod: "card", fields: {} })
    );

    render(<RegistrationForm />);

    if (!OFFERED_PAYMENT_METHODS.includes("card")) {
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Submit registration/i })).toBeDefined()
      );
    }
  });

  it("survives a corrupted draft instead of showing a broken form", async () => {
    sessionStorage.setItem(REGISTRATION_DRAFT_KEY, "{not json");
    render(<RegistrationForm />);

    expect(screen.getByLabelText(/^Name/)).toBeDefined();
    await waitFor(() => expect(sessionStorage.getItem(REGISTRATION_DRAFT_KEY)).not.toBe("{not json"));
  });

  it("clears the draft once the entry is in, so the next person starts fresh", async () => {
    const u = user();
    render(<RegistrationForm />);
    await fillRequired(u);
    await waitFor(() => expect(draft()).not.toBeNull());

    await u.click(screen.getByRole("button", { name: /Submit/i }));
    await screen.findByText(/Thank you!/);

    expect(sessionStorage.getItem(REGISTRATION_DRAFT_KEY)).toBeNull();
  });

  it("does not break when storage is unavailable", async () => {
    // Private browsing, or a full quota — losing the draft is not worth
    // breaking the form over.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    const u = user();
    render(<RegistrationForm />);
    await u.type(screen.getByLabelText(/^Name/), "Máire");

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Máire");
    setItem.mockRestore();
  });
});
