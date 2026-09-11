/**
 * The two payment routes that are currently switched off.
 *
 * `CARD_PAYMENT_ENABLED` and `INVOICE_PAYMENT_ENABLED` are false, so the branches
 * below cannot be reached through the live form — but the Checkout path, the
 * invoicing path, the return page and the webhook that settles them are all
 * intact, because turning either back on is meant to be one constant. Dark code
 * that nobody exercises is dark code that has quietly broken by the time someone
 * flips the switch, so this file flips it here and drives both routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../helpers/supabase";
import { FakeCookieStore, captureRedirect, fakeHeaders, redirectDouble } from "../helpers/next";
import { registrationForm, uuid } from "../helpers/factories";
import type { Registration } from "@/lib/types";

const db = new FakeSupabase();
let cookieStore = new FakeCookieStore();
let requestHeaders: Record<string, string> = {};

vi.mock("@/lib/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/types")>();
  const offered = ["card", "invoice", "transfer"] as const;
  return {
    ...actual,
    CARD_PAYMENT_ENABLED: true,
    INVOICE_PAYMENT_ENABLED: true,
    OFFERED_PAYMENT_METHODS: [...offered],
    DEFAULT_PAYMENT_METHOD: "card",
    isOfferedPaymentMethod: (value: string) => (offered as readonly string[]).includes(value),
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => fakeHeaders(requestHeaders),
}));

vi.mock("next/navigation", () => ({ redirect: redirectDouble }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getAdminClient: () => db, getPublicClient: () => db }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
}));
vi.mock("@/lib/email", () => ({
  sendTransferInstructions: vi.fn(async () => {}),
  sendPaidConfirmation: vi.fn(async () => {}),
}));

const createCheckoutSession = vi.fn(async () => ({
  id: "cs_test_1",
  url: "https://checkout.stripe.com/c/pay/cs_test_1",
}));
const createAndSendInvoice = vi.fn(async () => ({
  id: "in_test_1",
  customer: "cus_test_1",
  hosted_invoice_url: "https://invoice.stripe.com/i/test",
  number: "LGC-0001",
}));

vi.mock("@/lib/payments", () => ({ createCheckoutSession, createAndSendInvoice }));

const { submitRegistration } = await import("@/app/actions");

const DRAFT_COOKIE = "lgc_draft";

/** The origin Stripe was told to send the payer back to. */
function originPassedToStripe(): string {
  const [, , origin] = createCheckoutSession.mock.calls[0] as unknown as [
    unknown,
    unknown,
    string,
  ];
  return origin;
}

function savedRow(): Registration {
  const rows = db.rows<Registration>("registrations");
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeEach(() => {
  db.reset();
  cookieStore = new FakeCookieStore();
  requestHeaders = { "x-forwarded-for": "203.0.113.7" };
  vi.clearAllMocks();
  createCheckoutSession.mockResolvedValue({
    id: "cs_test_1",
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
  });
  createAndSendInvoice.mockResolvedValue({
    id: "in_test_1",
    customer: "cus_test_1",
    hosted_invoice_url: "https://invoice.stripe.com/i/test",
    number: "LGC-0001",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("paying by card", () => {
  it("sends the payer to Stripe's hosted checkout", async () => {
    const to = await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(to).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
  });

  it("bills exactly what was registered", async () => {
    await captureRedirect(() =>
      submitRegistration(
        { ok: false },
        registrationForm({
          payment_method: "card",
          number_of_teams: "2",
          tee_box_count: "1",
          donation_amount: "50",
        })
      )
    );

    const [payer, lines] = createCheckoutSession.mock.calls[0] as unknown as [
      { registrationId: string; email: string },
      Array<{ lookupKey: string; quantity: number; unitAmount?: number }>,
    ];

    expect(payer.registrationId).toBe(savedRow().id);
    expect(payer.email).toBe("maire@example.ie");
    expect(lines.map((l) => [l.lookupKey, l.quantity])).toEqual([
      ["gc2026_team", 2],
      ["gc2026_tee_box", 1],
      ["gc2026_donation", 1],
    ]);
    expect(lines[2].unitAmount).toBe(5000);
  });

  it("records the checkout session against the row, so the webhook can match it", async () => {
    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(savedRow().stripe_checkout_session_id).toBe("cs_test_1");
  });

  it("remembers the draft before leaving, so Back does not create a second entry", async () => {
    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );

    const cookie = cookieStore.get(DRAFT_COOKIE);
    expect(cookie?.value).toBe(savedRow().id);
    expect(cookieStore.optionsFor(DRAFT_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("updates that same row when the payer comes back and resubmits", async () => {
    const first = await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(first).toContain("checkout.stripe.com");

    await captureRedirect(() =>
      submitRegistration(
        { ok: false },
        registrationForm({ payment_method: "card", number_of_teams: "3" })
      )
    );

    // One row, not a trail of duplicate "awaiting payment" entries.
    expect(db.rows("registrations")).toHaveLength(1);
    expect(savedRow().number_of_teams).toBe(3);
  });

  it("does not let the redirect be caught and reported as a failure", async () => {
    // redirect() signals by throwing; catching it inside the try would turn a
    // successful hand-off into "we couldn't start the card payment".
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "card" })
    ).catch((e) => e);

    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("NEXT_REDIRECT");
  });

  it("keeps the saved details when Stripe cannot be reached, and says so", async () => {
    createCheckoutSession.mockRejectedValueOnce(new Error("Stripe is down"));
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "card" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Your details were saved/);
    expect(result.error).toMatch(/choose bank transfer/);
    expect(db.rows("registrations")).toHaveLength(1);
  });

  it("reports a session that arrives without a URL rather than redirecting nowhere", async () => {
    createCheckoutSession.mockResolvedValueOnce({ id: "cs_test_1", url: "" });
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "card" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/couldn't start the card payment/);
  });

  it("refuses a card payment for an empty basket", async () => {
    // Stripe cannot raise a zero-euro checkout, even when a prize was pledged.
    const result = await submitRegistration(
      { ok: false },
      registrationForm({
        payment_method: "card",
        number_of_teams: "0",
        team_1_player_1_name: undefined as never,
        sponsor_raffle: "on",
        raffle_prize: "A hamper",
      })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nothing to register yet/);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("where Stripe sends the payer back to", () => {
  it("uses the configured site URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://golf.example.ie");
    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(originPassedToStripe()).toBe("https://golf.example.ie");
  });

  it("tolerates a trailing slash on it", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://golf.example.ie///");
    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(originPassedToStripe()).toBe("https://golf.example.ie");
  });

  it("falls back to the forwarded host, so a preview returns to itself", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    requestHeaders = {
      "x-forwarded-host": "preview-abc.vercel.app",
      "x-forwarded-proto": "https",
    };

    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(originPassedToStripe()).toBe("https://preview-abc.vercel.app");
  });

  it("falls back to the plain host header", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    requestHeaders = { host: "localhost:3000", "x-forwarded-proto": "http" };

    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(originPassedToStripe()).toBe("http://localhost:3000");
  });

  it("assumes https when no protocol was forwarded", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    requestHeaders = { host: "golf.example.ie" };

    await captureRedirect(() =>
      submitRegistration({ ok: false }, registrationForm({ payment_method: "card" }))
    );
    expect(originPassedToStripe()).toBe("https://golf.example.ie");
  });

  it("reports a failure rather than sending the payer to a guessed origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    requestHeaders = {};

    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "card" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/couldn't start the card payment/);
  });
});

describe("asking to be invoiced", () => {
  it("confirms the invoice route and hands back the hosted page", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "invoice" })
    );

    expect(result).toMatchObject({
      ok: true,
      method: "invoice",
      invoiceUrl: "https://invoice.stripe.com/i/test",
    });
  });

  it("records the invoice against the row", async () => {
    await submitRegistration({ ok: false }, registrationForm({ payment_method: "invoice" }));
    const row = savedRow();

    expect(row.stripe_invoice_id).toBe("in_test_1");
    expect(row.stripe_invoice_number).toBe("LGC-0001");
    expect(row.stripe_invoice_url).toBe("https://invoice.stripe.com/i/test");
    expect(row.stripe_customer_id).toBe("cus_test_1");
  });

  it("reads the customer id whether Stripe expands it or not", async () => {
    createAndSendInvoice.mockResolvedValueOnce({
      id: "in_test_2",
      customer: { id: "cus_expanded" },
      hosted_invoice_url: "https://invoice.stripe.com/i/2",
      number: "LGC-0002",
    } as never);

    await submitRegistration({ ok: false }, registrationForm({ payment_method: "invoice" }));
    expect(savedRow().stripe_customer_id).toBe("cus_expanded");
  });

  it("clears the draft, because the entry is complete", async () => {
    cookieStore.set(DRAFT_COOKIE, uuid());
    await submitRegistration({ ok: false }, registrationForm({ payment_method: "invoice" }));
    expect(cookieStore.has(DRAFT_COOKIE)).toBe(false);
  });

  it("never re-uses a row an invoice already went out for", async () => {
    // Re-using it would email the payer a second invoice for the same entry.
    const existing = uuid();
    db.seed("registrations", [
      { id: existing, payment_status: "pending", stripe_invoice_id: "in_old" },
    ]);
    cookieStore.set(DRAFT_COOKIE, existing);

    await submitRegistration({ ok: false }, registrationForm({ payment_method: "invoice" }));

    expect(db.rows("registrations")).toHaveLength(2);
    expect(db.row<Registration>("registrations", existing)?.stripe_invoice_id).toBe("in_old");
  });

  it("keeps the saved details when the invoice cannot be raised, and says so", async () => {
    createAndSendInvoice.mockRejectedValueOnce(new Error("Stripe rejected the invoice"));
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "invoice" })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/couldn't raise the invoice/);
    expect(result.error).toMatch(/choose bank transfer/);
    expect(db.rows("registrations")).toHaveLength(1);
  });

  it("does not leak Stripe's own error text to the payer", async () => {
    createAndSendInvoice.mockRejectedValueOnce(
      new Error("No such customer: cus_123 (request req_abc)")
    );
    const result = await submitRegistration(
      { ok: false },
      registrationForm({ payment_method: "invoice" })
    );

    expect(result.error).not.toMatch(/cus_123|req_abc/);
  });

  it("refuses to invoice an empty basket", async () => {
    const result = await submitRegistration(
      { ok: false },
      registrationForm({
        payment_method: "invoice",
        number_of_teams: "0",
        team_1_player_1_name: undefined as never,
        sponsor_raffle: "on",
      })
    );

    expect(result.ok).toBe(false);
    expect(createAndSendInvoice).not.toHaveBeenCalled();
  });
});
