import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../helpers/supabase";
import { FakeCookieStore, captureRedirect, fakeHeaders, redirectDouble } from "../helpers/next";
import { registrationForm, uuid } from "../helpers/factories";
import {
  DEFAULT_PAYMENT_METHOD,
  MAX_DONATION,
  MAX_GREENS,
  MAX_TEAMS,
  MAX_TEE_BOXES,
  PRICE_PER_GREEN,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  type Registration,
} from "@/lib/types";

const db = new FakeSupabase();
let cookieStore = new FakeCookieStore();
let requestHeaders: Record<string, string> = {};
let rateLimitAllowed = true;

vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => fakeHeaders(requestHeaders),
}));

vi.mock("next/navigation", () => ({ redirect: redirectDouble }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  getAdminClient: () => db,
  getPublicClient: () => db,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: rateLimitAllowed, count: 1 })),
}));

vi.mock("@/lib/email", () => ({
  sendTransferInstructions: vi.fn(async () => {}),
  sendPaidConfirmation: vi.fn(async () => {}),
}));

vi.mock("@/lib/payments", () => ({
  createCheckoutSession: vi.fn(async () => ({
    id: "cs_test_1",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
  })),
  createAndSendInvoice: vi.fn(async () => ({
    id: "in_1",
    customer: "cus_1",
    hosted_invoice_url: "https://invoice.stripe.com/i/1",
    number: "LGC-0001",
  })),
}));

const {
  submitRegistration,
  markRegistrationPaid,
  revertRegistrationToPending,
  login,
  logout,
} = await import("@/app/actions");

const { checkRateLimit } = await import("@/lib/rate-limit");
const { sendTransferInstructions, sendPaidConfirmation } = await import("@/lib/email");
const { revalidatePath } = await import("next/cache");
const { createSessionToken } = await import("@/lib/auth");

const DRAFT_COOKIE = "lgc_draft";
const SESSION_COOKIE = "lgc_admin_session";

/** The single row the public client wrote. */
function savedRow(): Registration {
  const rows = db.rows<Registration>("registrations");
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeEach(() => {
  db.reset();
  cookieStore = new FakeCookieStore();
  requestHeaders = { "x-forwarded-for": "203.0.113.7" };
  rateLimitAllowed = true;
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

describe("submitRegistration — validation", () => {
  it("requires a name", async () => {
    const result = await submitRegistration({ ok: false }, registrationForm({ name: "" }));
    expect(result).toEqual({
      ok: false,
      error: "Please fill in your name, mobile and email.",
    });
    expect(db.rows("registrations")).toHaveLength(0);
  });

  it("requires a mobile number", async () => {
    const result = await submitRegistration({ ok: false }, registrationForm({ mobile: "  " }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name, mobile and email/);
  });

  it("requires an email address", async () => {
    const result = await submitRegistration({ ok: false }, registrationForm({ email: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects an address that is not an email", async () => {
    for (const bad of ["maire", "maire@", "@example.ie", "maire@example", "a b@c.ie"]) {
      const result = await submitRegistration({ ok: false }, registrationForm({ email: bad }));
      expect(result.error, `accepted "${bad}"`).toBe("Please enter a valid email address.");
    }
  });

  it("accepts an ordinary address with a plus tag and a subdomain", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ email: "maire+golf@mail.example.co.uk" })
    );
    expect(result.ok).toBe(true);
  });

  it("requires the first player's name once a team is selected", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ team_1_player_1_name: "" })
    );
    expect(result).toEqual({
      ok: false,
      error: "Please enter at least the first player's name for Team 1.",
    });
  });

  it("accepts a team whose captain slot is blank but has another named player", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ team_1_player_1_name: "", team_1_player_3_name: "Cormac" })
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an entry with nothing in it at all", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ number_of_teams: "0", team_1_player_1_name: undefined as never })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nothing to register yet/);
    expect(db.rows("registrations")).toHaveLength(0);
  });

  it("accepts a raffle-prize-only entry, which costs nothing", async () => {
    // A prize donor had no way through this form without buying a team entry
    // they did not want.
    const result = await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "0",
        team_1_player_1_name: undefined as never,
        sponsor_raffle: "on",
        raffle_prize: "Hamper",
        payment_method: "transfer",
      })
    );
    expect(result).toEqual({ ok: true, method: "transfer" });
    expect(savedRow().total_amount).toBe(0);
  });

  it("accepts a donation with no team", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "0",
        team_1_player_1_name: undefined as never,
        donation_amount: "75",
      })
    );
    expect(result.ok).toBe(true);
    expect(savedRow().total_amount).toBe(75);
  });

  it("accepts a sponsorship with no team", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "0",
        team_1_player_1_name: undefined as never,
        tee_box_count: "1",
      })
    );
    expect(result.ok).toBe(true);
    expect(savedRow().total_amount).toBe(PRICE_PER_TEE_BOX);
  });
});

/* ------------------------------------------------------------------ *
 * Clamping — everything here comes from the browser and feeds the total
 * ------------------------------------------------------------------ */

describe("submitRegistration — clamping", () => {
  it("clamps a crafted team count to the maximum on offer", async () => {
    await submitRegistration({ ok: false }, registrationForm({ number_of_teams: "999999" }));
    expect(savedRow().number_of_teams).toBe(MAX_TEAMS);
  });

  it("clamps tee boxes and greens", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({ tee_box_count: "40", green_count: "40" })
    );
    const row = savedRow();
    expect(row.tee_box_count).toBe(MAX_TEE_BOXES);
    expect(row.green_count).toBe(MAX_GREENS);
  });

  it("clamps an absurd donation", async () => {
    await submitRegistration({ ok: false }, registrationForm({ donation_amount: "99999999" }));
    expect(savedRow().donation_amount).toBe(MAX_DONATION);
  });

  it("treats a negative quantity as zero rather than a credit", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "1",
        tee_box_count: "-5",
        green_count: "-1",
        donation_amount: "-1000",
      })
    );
    const row = savedRow();
    expect(row.tee_box_count).toBe(0);
    expect(row.green_count).toBe(0);
    expect(row.donation_amount).toBe(0);
    expect(row.total_amount).toBe(PRICE_PER_TEAM);
  });

  it("treats unparseable numbers as zero", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "two",
        team_1_player_1_name: undefined as never,
        tee_box_count: "lots",
        green_count: "NaN",
        donation_amount: "€50",
        sponsor_raffle: "on",
      })
    );
    const row = savedRow();
    expect(row.number_of_teams).toBe(0);
    expect(row.total_amount).toBe(0);
  });

  it("stores the total the constants produce, not one the browser sent", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "2",
        tee_box_count: "1",
        green_count: "1",
        donation_amount: "50",
        total_amount: "1",
      })
    );
    expect(savedRow().total_amount).toBe(
      2 * PRICE_PER_TEAM + PRICE_PER_TEE_BOX + PRICE_PER_GREEN + 50
    );
  });

  it("truncates oversized text before it can reach Stripe or the database", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({
        name: "n".repeat(500),
        mobile: "0".repeat(100),
        // Long, but still an address: truncation happens before the format
        // check, so an over-long local part would be rejected as invalid
        // rather than trimmed.
        email: `${"e".repeat(200)}@example.ie`,
        company_or_club: "c".repeat(500),
        sponsor_raffle: "on",
        raffle_prize: "p".repeat(3000),
      })
    );
    const row = savedRow();
    expect(row.name).toHaveLength(200);
    expect(row.mobile).toHaveLength(40);
    expect(row.email.length).toBeLessThanOrEqual(254);
    expect(row.company_or_club).toHaveLength(200);
    expect(row.raffle_prize).toHaveLength(1000);
  });

  it("trims surrounding whitespace", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({ name: "  Máire  ", email: "  maire@example.ie  " })
    );
    const row = savedRow();
    expect(row.name).toBe("Máire");
    expect(row.email).toBe("maire@example.ie");
  });

  it("stores an omitted optional field as null rather than an empty string", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({ company_or_club: "", address: "" })
    );
    const row = savedRow();
    expect(row.company_or_club).toBeNull();
    expect(row.address).toBeNull();
  });

  it("discards a raffle prize typed before the box was unticked", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({ raffle_prize: "Hamper", sponsor_raffle: undefined as never })
    );
    const row = savedRow();
    expect(row.sponsor_raffle).toBe(false);
    expect(row.raffle_prize).toBeNull();
  });

  it("records only as many teams as were selected", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({
        number_of_teams: "2",
        team_1_player_1_name: "Ann",
        team_2_player_1_name: "Bríd",
        team_3_player_1_name: "Should be ignored",
      })
    );
    const row = savedRow();
    expect(row.teams).toHaveLength(2);
    expect(row.teams[1].players[0].name).toBe("Bríd");
    expect(JSON.stringify(row.teams)).not.toContain("Should be ignored");
  });

  it("keeps four player slots per team, named or not", async () => {
    await submitRegistration({ ok: false }, registrationForm());
    expect(savedRow().teams[0].players).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ *
 * Payment method
 * ------------------------------------------------------------------ */

describe("submitRegistration — payment method", () => {
  it("honours a method that is on offer", async () => {
    await submitRegistration({ ok: false }, registrationForm({ payment_method: "transfer" }));
    expect(savedRow().payment_method).toBe("transfer");
  });

  it("falls back to the default for junk", async () => {
    await submitRegistration({ ok: false }, registrationForm({ payment_method: "crypto" }));
    expect(savedRow().payment_method).toBe(DEFAULT_PAYMENT_METHOD);
  });

  it("falls back when no method was posted at all", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: undefined as never })
    );
    expect(savedRow().payment_method).toBe(DEFAULT_PAYMENT_METHOD);
  });

  it("refuses a hand-posted card payment while card payment is switched off", async () => {
    // The form field is the only thing that was removed; honouring a posted
    // "card" would start a checkout the club is no longer taking.
    await submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }));
    const { createCheckoutSession } = await import("@/lib/payments");

    expect(savedRow().payment_method).toBe(DEFAULT_PAYMENT_METHOD);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses a hand-posted invoice request while invoicing is switched off", async () => {
    // Otherwise anyone could make the club's live Stripe account email a formal
    // invoice to an address of their choosing.
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "invoice" })
    );
    const { createAndSendInvoice } = await import("@/lib/payments");

    expect(savedRow().payment_method).toBe(DEFAULT_PAYMENT_METHOD);
    expect(createAndSendInvoice).not.toHaveBeenCalled();
    expect(result.method).toBe("transfer");
  });
});

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

describe("submitRegistration — rate limiting", () => {
  it("turns away a caller over the limit without saving anything", async () => {
    rateLimitAllowed = false;
    const result = await submitRegistration({ ok: false }, registrationForm());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Too many registrations/);
    expect(db.rows("registrations")).toHaveLength(0);
  });

  it("charges the budget against the registration scope", async () => {
    await submitRegistration({ ok: false }, registrationForm());
    expect(checkRateLimit).toHaveBeenCalledWith("registration");
  });

  it("does not spend the budget on a submission that failed validation", async () => {
    // Someone mistyping their email four times then fumbling the captain's name
    // could otherwise lock out a whole clubhouse sharing one address.
    await submitRegistration({ ok: false }, registrationForm({ email: "nope" }));
    await submitRegistration({ ok: false }, registrationForm({ name: "" }));
    await submitRegistration({ ok: false }, registrationForm({ team_1_player_1_name: "" }));
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Persistence and the resumable draft
 * ------------------------------------------------------------------ */

describe("submitRegistration — saving", () => {
  it("inserts a pending row with a server-generated id", async () => {
    await submitRegistration({ ok: false }, registrationForm());
    const row = savedRow();

    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(row.payment_status).toBe("pending");
  });

  it("reports a save failure without echoing the database error", async () => {
    // Raw Postgres errors disclose table and column names to anyone probing.
    db.failOnce("registrations", "insert", {
      message: 'null value in column "mobile" of relation "registrations"',
    });
    const result = await submitRegistration({ ok: false }, registrationForm());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Sorry, we couldn't save your registration. Please try again.");
    expect(result.error).not.toMatch(/registrations|column/);
  });

  it("does not email anyone when the save failed", async () => {
    db.failOnce("registrations", "insert", { message: "boom" });
    await submitRegistration({ ok: false }, registrationForm());
    expect(sendTransferInstructions).not.toHaveBeenCalled();
  });

  it("updates the row this browser abandoned rather than duplicating it", async () => {
    const existing = uuid();
    db.seed("registrations", [
      { id: existing, payment_status: "pending", stripe_invoice_id: null, name: "Old name" },
    ]);
    cookieStore.set(DRAFT_COOKIE, existing);

    await submitRegistration({ ok: false }, registrationForm({ name: "New name" }));

    expect(db.rows("registrations")).toHaveLength(1);
    expect(db.row<Registration>("registrations", existing)?.name).toBe("New name");
  });

  it("starts a new row when the draft has already been paid", async () => {
    const existing = uuid();
    db.seed("registrations", [
      { id: existing, payment_status: "paid", stripe_invoice_id: null, name: "Paid entry" },
    ]);
    cookieStore.set(DRAFT_COOKIE, existing);

    await submitRegistration({ ok: false }, registrationForm({ name: "Someone else" }));

    expect(db.rows("registrations")).toHaveLength(2);
    expect(db.row<Registration>("registrations", existing)?.name).toBe("Paid entry");
  });

  it("starts a new row when an invoice already went out for the draft", async () => {
    // Re-using it would email a second invoice.
    const existing = uuid();
    db.seed("registrations", [
      { id: existing, payment_status: "pending", stripe_invoice_id: "in_1" },
    ]);
    cookieStore.set(DRAFT_COOKIE, existing);

    await submitRegistration({ ok: false }, registrationForm());
    expect(db.rows("registrations")).toHaveLength(2);
  });

  it("ignores a draft cookie that is not a UUID", async () => {
    cookieStore.set(DRAFT_COOKIE, "../../etc/passwd");
    await submitRegistration({ ok: false }, registrationForm());
    expect(db.rows("registrations")).toHaveLength(1);
  });

  it("ignores a draft cookie naming a row that does not exist", async () => {
    cookieStore.set(DRAFT_COOKIE, uuid());
    await submitRegistration({ ok: false }, registrationForm());
    expect(db.rows("registrations")).toHaveLength(1);
  });

  it("starts a new row when the draft lookup itself fails", async () => {
    db.failOnce("registrations", "select", { message: "timeout" });
    cookieStore.set(DRAFT_COOKIE, uuid());
    await submitRegistration({ ok: false }, registrationForm());
    expect(db.rows("registrations")).toHaveLength(1);
  });

  it("clears the draft cookie once the entry is complete", async () => {
    cookieStore.set(DRAFT_COOKIE, uuid());
    await submitRegistration({ ok: false }, registrationForm());
    expect(cookieStore.has(DRAFT_COOKIE)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Bank transfer
 * ------------------------------------------------------------------ */

describe("submitRegistration — bank transfer", () => {
  it("confirms the transfer route to the form", async () => {
    const result = await submitRegistration({ ok: false }, registrationForm());
    expect(result).toEqual({ ok: true, method: "transfer" });
  });

  it("emails payment instructions before returning", async () => {
    // Awaited, not fired and forgotten: a serverless function can be frozen the
    // instant its response is returned, cutting an in-flight send off.
    await submitRegistration({ ok: false }, registrationForm());
    expect(sendTransferInstructions).toHaveBeenCalledTimes(1);
  });

  it("passes the saved entry to the email, id included", async () => {
    await submitRegistration(
      { ok: false },
      registrationForm({ number_of_teams: "2", team_2_player_1_name: "Bríd" })
    );
    const entry = vi.mocked(sendTransferInstructions).mock.calls[0][0];

    expect(entry.id).toBe(savedRow().id);
    expect(entry.email).toBe("maire@example.ie");
    expect(entry.total_amount).toBe(2 * PRICE_PER_TEAM);
    expect(entry.teams).toHaveLength(2);
  });

  it("still registers the entry when the email cannot be sent", async () => {
    vi.mocked(sendTransferInstructions).mockRejectedValueOnce(new Error("resend down"));
    await expect(submitRegistration({ ok: false }, registrationForm())).rejects.toThrow();
    // The row is saved before the email is attempted, which is the part that
    // must survive.
    expect(db.rows("registrations")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Recording a payment Stripe never saw
 * ------------------------------------------------------------------ */

describe("markRegistrationPaid", () => {
  const id = uuid();

  function seedPending(overrides: Record<string, unknown> = {}) {
    db.seed("registrations", [
      {
        id,
        name: "Máire",
        email: "maire@example.ie",
        total_amount: 2200,
        payment_status: "pending",
        amount_paid: 0,
        paid_at: null,
        paid_confirmation_sent_at: null,
        payment_recorded_by: null,
        payment_note: null,
        ...overrides,
      },
    ]);
  }

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  }

  async function signIn() {
    cookieStore.set(SESSION_COOKIE, await createSessionToken());
  }

  it("refuses when nobody is signed in", async () => {
    // Checked on the server, not merely hidden in the dashboard: "the button
    // isn't rendered" is not an access control.
    seedPending();
    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));

    expect(result).toEqual({ error: "Your session has expired. Please sign in again." });
    expect(db.row<Registration>("registrations", id)?.payment_status).toBe("pending");
  });

  it("refuses a forged session cookie", async () => {
    seedPending();
    cookieStore.set(SESSION_COOKIE, "authenticated.abc.deadbeef");
    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));
    expect(result.error).toMatch(/session has expired/);
  });

  it("refuses a session that has aged past its TTL", async () => {
    // The 8 hours are baked into the signed token, not just into the cookie's
    // maxAge — a browser is free to ignore the latter, and a value copied out
    // of one browser and into another carries no expiry with it at all.
    seedPending();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    await signIn();
    vi.setSystemTime(new Date("2026-09-01T18:00:00Z"));

    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));
    vi.useRealTimers();

    expect(result.error).toMatch(/session has expired/);
    expect(db.row<Registration>("registrations", id)?.payment_status).toBe("pending");
  });

  it("refuses a session minted under a superseded epoch", async () => {
    // `logout` only clears the cookie in the browser that asked; a token already
    // copied elsewhere stays good for its 8 hours. Bumping ADMIN_SESSION_EPOCH
    // is what revokes it everywhere at once, and this is the action that has to
    // honour that — it moves money state.
    seedPending();
    await signIn();
    vi.stubEnv("ADMIN_SESSION_EPOCH", "2");

    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));

    expect(result.error).toMatch(/session has expired/);
    expect(db.row<Registration>("registrations", id)?.payment_status).toBe("pending");
  });

  it("accepts a session minted under the current epoch", async () => {
    vi.stubEnv("ADMIN_SESSION_EPOCH", "2");
    seedPending();
    await signIn();

    expect(
      await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }))
    ).toEqual({ ok: true });
  });

  it("records the amount, the time and who recorded it", async () => {
    await signIn();
    seedPending();
    const result = await markRegistrationPaid(
      {},
      form({ registration_id: id, amount: "2200", note: "Bank ref 55123" })
    );

    const row = db.row<Registration>("registrations", id)!;
    expect(result).toEqual({ ok: true });
    expect(row.payment_status).toBe("paid");
    expect(row.amount_paid).toBe(2200);
    expect(row.payment_recorded_by).toBe("organiser");
    expect(row.payment_note).toBe("Bank ref 55123");
    expect(row.paid_at).not.toBeNull();
  });

  it("records a part payment at the amount that actually arrived", async () => {
    await signIn();
    seedPending();
    await markRegistrationPaid({}, form({ registration_id: id, amount: "1100" }));
    expect(db.row<Registration>("registrations", id)?.amount_paid).toBe(1100);
  });

  it("emails the payer, but not the organiser who just clicked the button", async () => {
    await signIn();
    seedPending();
    await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));

    expect(sendPaidConfirmation).toHaveBeenCalledTimes(1);
    const [, amount, opts] = vi.mocked(sendPaidConfirmation).mock.calls[0];
    expect(amount).toBe(2200);
    expect(opts).toEqual({ notifyOrganisers: false });
  });

  it("sends one confirmation however many times the button is clicked", async () => {
    await signIn();
    seedPending();
    await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));
    await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));
    expect(sendPaidConfirmation).toHaveBeenCalledTimes(1);
  });

  it("will not overwrite a payment Stripe confirmed", async () => {
    // Stripe's word beats a volunteer's: a bank-verified figure must not be
    // replaced by a typed one.
    await signIn();
    seedPending({
      payment_status: "paid",
      payment_recorded_by: "stripe",
      amount_paid: 2200,
    });
    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "10" }));

    expect(result.error).toMatch(/Stripe has already confirmed/);
    expect(db.row<Registration>("registrations", id)?.amount_paid).toBe(2200);
  });

  it("lets an organiser correct a figure they recorded themselves", async () => {
    await signIn();
    seedPending({
      payment_status: "paid",
      payment_recorded_by: "organiser",
      amount_paid: 1100,
      paid_confirmation_sent_at: "2026-09-01T12:00:00.000Z",
    });
    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));

    expect(result).toEqual({ ok: true });
    expect(db.row<Registration>("registrations", id)?.amount_paid).toBe(2200);
    // The confirmation already went out, so the correction must not re-send it.
    expect(sendPaidConfirmation).not.toHaveBeenCalled();
  });

  it("rejects a registration id that is not a UUID", async () => {
    await signIn();
    const result = await markRegistrationPaid({}, form({ registration_id: "1 OR 1=1", amount: "1" }));
    expect(result).toEqual({ error: "That registration could not be identified." });
  });

  it("rejects an amount of zero or less", async () => {
    await signIn();
    seedPending();
    for (const amount of ["0", "-500", "", "lots"]) {
      const result = await markRegistrationPaid({}, form({ registration_id: id, amount }));
      expect(result).toEqual({ error: "Enter the amount that was actually received." });
    }
    expect(db.row<Registration>("registrations", id)?.payment_status).toBe("pending");
  });

  it("reports a row that does not exist as nothing to record", async () => {
    await signIn();
    const result = await markRegistrationPaid({}, form({ registration_id: uuid(), amount: "10" }));
    expect(result.error).toMatch(/Nothing to record/);
  });

  it("stores an empty note as null", async () => {
    await signIn();
    seedPending();
    await markRegistrationPaid({}, form({ registration_id: id, amount: "2200", note: "  " }));
    expect(db.row<Registration>("registrations", id)?.payment_note).toBeNull();
  });

  it("reports a database failure without leaking it", async () => {
    await signIn();
    seedPending();
    db.failOnce("registrations", "update", { message: 'column "amount_paid" does not exist' });
    const result = await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));

    expect(result).toEqual({ error: "Could not record that payment. Please try again." });
  });

  it("refreshes the dashboard afterwards", async () => {
    await signIn();
    seedPending();
    await markRegistrationPaid({}, form({ registration_id: id, amount: "2200" }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });
});

describe("revertRegistrationToPending", () => {
  const id = uuid();

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  }

  async function signIn() {
    cookieStore.set(SESSION_COOKIE, await createSessionToken());
  }

  it("refuses when nobody is signed in", async () => {
    const result = await revertRegistrationToPending({}, form({ registration_id: id }));
    expect(result.error).toMatch(/session has expired/);
  });

  it("undoes an organiser's own entry and clears every trace of it", async () => {
    await signIn();
    db.seed("registrations", [
      {
        id,
        payment_status: "paid",
        amount_paid: 2200,
        paid_at: "2026-09-01T12:00:00.000Z",
        payment_recorded_by: "organiser",
        payment_note: "Bank ref",
        paid_confirmation_sent_at: "2026-09-01T12:00:00.000Z",
      },
    ]);

    const result = await revertRegistrationToPending({}, form({ registration_id: id }));
    const row = db.row<Registration>("registrations", id)!;

    expect(result).toEqual({ ok: true });
    expect(row.payment_status).toBe("pending");
    expect(row.amount_paid).toBe(0);
    expect(row.paid_at).toBeNull();
    expect(row.payment_recorded_by).toBeNull();
    expect(row.payment_note).toBeNull();
    // Cleared too, so correcting a mistake and recording it again still sends
    // the payer their confirmation.
    expect(row.paid_confirmation_sent_at).toBeNull();
  });

  it("never unwinds a payment Stripe settled", async () => {
    await signIn();
    db.seed("registrations", [
      { id, payment_status: "paid", amount_paid: 2200, payment_recorded_by: "stripe" },
    ]);

    const result = await revertRegistrationToPending({}, form({ registration_id: id }));

    expect(result.error).toMatch(/Only a payment recorded by an organiser/);
    expect(db.row<Registration>("registrations", id)?.payment_status).toBe("paid");
  });

  it("rejects an id that is not a UUID", async () => {
    await signIn();
    const result = await revertRegistrationToPending({}, form({ registration_id: "x" }));
    expect(result).toEqual({ error: "That registration could not be identified." });
  });

  it("reports a database failure without leaking it", async () => {
    await signIn();
    db.failOnce("registrations", "update", { message: "deadlock detected" });
    const result = await revertRegistrationToPending({}, form({ registration_id: id }));
    expect(result).toEqual({ error: "Could not undo that. Please try again." });
  });

  it("refreshes the dashboard afterwards", async () => {
    await signIn();
    db.seed("registrations", [{ id, payment_status: "paid", payment_recorded_by: "organiser" }]);
    await revertRegistrationToPending({}, form({ registration_id: id }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });
});

/* ------------------------------------------------------------------ *
 * Organiser login
 * ------------------------------------------------------------------ */

describe("login", () => {
  function credentials(username: string, password: string) {
    const data = new FormData();
    data.set("username", username);
    data.set("password", password);
    return data;
  }

  it("signs in with the configured credentials and lands on the dashboard", async () => {
    const to = await captureRedirect(() =>
      login({}, credentials("organiser", "correct-horse-battery"))
    );
    expect(to).toBe("/admin");
  });

  it("sets a session cookie the proxy will accept", async () => {
    await captureRedirect(() => login({}, credentials("organiser", "correct-horse-battery")));
    const { verifySessionToken } = await import("@/lib/auth");

    const token = cookieStore.get(SESSION_COOKIE)?.value;
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("makes the cookie httpOnly, same-site and time-limited", async () => {
    await captureRedirect(() => login({}, credentials("organiser", "correct-horse-battery")));
    const options = cookieStore.optionsFor(SESSION_COOKIE)!;

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    // Same TTL the token carries, so cookie and signature lapse together.
    expect(options.maxAge).toBe(60 * 60 * 8);
  });

  it("rejects a wrong password without saying which half was wrong", async () => {
    const result = await login({}, credentials("organiser", "guess"));
    expect(result).toEqual({ error: "Invalid username or password." });
    expect(cookieStore.has(SESSION_COOKIE)).toBe(false);
  });

  it("rejects a wrong username with the identical message", async () => {
    const result = await login({}, credentials("someone", "correct-horse-battery"));
    expect(result).toEqual({ error: "Invalid username or password." });
  });

  it("caps how fast the shared password can be guessed", async () => {
    // The dashboard holds every registrant's contact details behind it.
    rateLimitAllowed = false;
    const result = await login({}, credentials("organiser", "correct-horse-battery"));

    expect(result.error).toMatch(/Too many attempts/);
    expect(cookieStore.has(SESSION_COOKIE)).toBe(false);
    expect(checkRateLimit).toHaveBeenCalledWith("admin-login", { failClosed: true });
  });

  it("counts a failed attempt against the limit, not just a successful one", async () => {
    await login({}, credentials("organiser", "wrong"));
    expect(checkRateLimit).toHaveBeenCalledWith("admin-login", { failClosed: true });
  });

  it("locks the door when the counter itself is unreachable", async () => {
    // Unlike the public form, this one fails closed: an unmetered guessing
    // budget against one shared password is worse than an outage.
    const { checkRateLimit: limiter } = await import("@/lib/rate-limit");
    expect(vi.mocked(limiter).mock.calls.length).toBe(0);

    rateLimitAllowed = false;
    const result = await login({}, credentials("organiser", "correct-horse-battery"));
    expect(result.error).toMatch(/Too many attempts/);
  });

  it("truncates an oversized submission rather than hashing megabytes", async () => {
    const result = await login({}, credentials("u".repeat(10_000), "p".repeat(10_000)));
    expect(result).toEqual({ error: "Invalid username or password." });
  });
});

describe("logout", () => {
  it("clears the session and returns to the login page", async () => {
    cookieStore.set(SESSION_COOKIE, await createSessionToken());
    const to = await captureRedirect(() => logout());

    expect(to).toBe("/admin/login");
    expect(cookieStore.has(SESSION_COOKIE)).toBe(false);
  });

  it("is harmless when there was no session to begin with", async () => {
    const to = await captureRedirect(() => logout());
    expect(to).toBe("/admin/login");
  });
});
