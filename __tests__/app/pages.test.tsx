// @vitest-environment jsdom
/**
 * The two pages that render on the server.
 *
 * Next's own guidance is that async Server Components are better covered
 * end-to-end than in a unit test, so these deliberately stay on what can be
 * settled here: which client each page reads through, what it does when that
 * read fails, and what a payer or an organiser ends up looking at. The
 * components are invoked directly and their resolved tree is rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FakeSupabase } from "../helpers/supabase";
import { FakeStripe } from "../helpers/stripe";
import { FakeCookieStore, RedirectError, redirectDouble } from "../helpers/next";
import { registration, uuid } from "../helpers/factories";
import { REGISTRATION_DRAFT_KEY, type Registration } from "@/lib/types";

const db = new FakeSupabase();
const stripe = new FakeStripe();
let cookieStore = new FakeCookieStore();

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("next/navigation", () => ({ redirect: redirectDouble }));
vi.mock("@/lib/supabase", () => ({ getAdminClient: () => db, getPublicClient: () => db }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));

/** Rendering the real dashboard needs a router; its own suite covers it. */
vi.mock("@/app/admin/Dashboard", () => ({
  default: ({ registrations }: { registrations: Registration[] }) => (
    <div data-testid="dashboard">{registrations.map((r) => <p key={r.id}>{r.name}</p>)}</div>
  ),
}));

const AdminPage = (await import("@/app/admin/page")).default;
const SuccessPage = (await import("@/app/register/success/page")).default;
const { createSessionToken } = await import("@/lib/auth");

beforeEach(() => {
  db.reset();
  stripe.calls = [];
  stripe.retrievedSessionOverrides = null;
  cookieStore = new FakeCookieStore();
  sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(cleanup);

async function signIn() {
  cookieStore.set("lgc_admin_session", await createSessionToken());
}

describe("the admin dashboard page", () => {
  it("turns an anonymous visitor away before reading a single row", async () => {
    // Belt and braces: the proxy already gates /admin, but this page reads every
    // registrant's contact details with the service-role key — too sensitive to
    // depend on a matcher config staying correct.
    await expect(AdminPage()).rejects.toBeInstanceOf(RedirectError);
    expect(db.calls).toHaveLength(0);
  });

  it("sends them to the login page", async () => {
    await expect(AdminPage()).rejects.toMatchObject({ url: "/admin/login" });
  });

  it("turns away an expired session as readily as no session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    await signIn();
    vi.setSystemTime(Date.now() + 9 * 60 * 60 * 1000);

    await expect(AdminPage()).rejects.toBeInstanceOf(RedirectError);
    vi.useRealTimers();
  });

  it("turns away a forged cookie", async () => {
    cookieStore.set("lgc_admin_session", "authenticated.1.abc.deadbeef");
    await expect(AdminPage()).rejects.toBeInstanceOf(RedirectError);
  });

  it("hands the registrations to the dashboard once signed in", async () => {
    await signIn();
    db.seed("registrations", [
      registration({ id: uuid(), name: "Máire Ní Bhriain" }),
      registration({ id: uuid(), name: "Pádraig Ó Sé" }),
    ]);

    render(await AdminPage());

    expect(screen.getByTestId("dashboard")).toBeDefined();
    expect(screen.getByText("Máire Ní Bhriain")).toBeDefined();
    expect(screen.getByText("Pádraig Ó Sé")).toBeDefined();
  });

  it("puts the newest registration first, which is the one being chased", async () => {
    await signIn();
    db.seed("registrations", [
      registration({ id: uuid(), name: "Older", created_at: "2026-08-01T10:00:00.000Z" }),
      registration({ id: uuid(), name: "Newest", created_at: "2026-09-10T10:00:00.000Z" }),
      registration({ id: uuid(), name: "Middle", created_at: "2026-09-01T10:00:00.000Z" }),
    ]);

    render(await AdminPage());
    const shown = screen
      .getByTestId("dashboard")
      .textContent;

    expect(shown).toBe("NewestMiddleOlder");
  });

  it("reads through the service-role client, which is what can see the rows", async () => {
    // The anon key is published to every browser that loads the site; nothing
    // it can satisfy should be able to read a registrant's contact details.
    await signIn();
    db.seed("registrations", [registration()]);
    render(await AdminPage());

    expect(db.calls.some((c) => c.table === "registrations" && c.op === "select")).toBe(true);
  });

  it("renders an empty dashboard rather than an error when nothing is in yet", async () => {
    await signIn();
    render(await AdminPage());
    expect(screen.getByTestId("dashboard")).toBeDefined();
  });

  it("explains a failed load, and says what to check", async () => {
    await signIn();
    // An Error instance, as supabase-js returns: PostgrestError extends Error,
    // and the page only surfaces the detail for something that is one.
    db.failOnce(
      "registrations",
      "select",
      Object.assign(new Error('relation "public.registrations" does not exist'), {
        code: "42P01",
      })
    );

    render(await AdminPage());

    expect(screen.getByText(/Could not load registrations/)).toBeDefined();
    expect(screen.getByText(/relation "public.registrations" does not exist/)).toBeDefined();
    expect(screen.getByText(/schema.sql/)).toBeDefined();
  });

  it("still offers a way out when the load failed", async () => {
    await signIn();
    db.failOnce("registrations", "select", { message: "boom" });
    render(await AdminPage());

    expect(screen.getByRole("button", { name: /Sign out/ })).toBeDefined();
  });
});

describe("the payment return page", () => {
  it("confirms a settled payment with the amount and the receipt address", async () => {
    stripe.retrievedSessionOverrides = {
      amount_total: 220000,
      payment_status: "paid",
      customer_details: { email: "payer@example.ie" },
    };

    render(await SuccessPage({ searchParams: Promise.resolve({ session_id: "cs_test_1" }) }));

    expect(screen.getByRole("heading", { name: /Payment received/ })).toBeDefined();
    expect(screen.getByText("€2,200")).toBeDefined();
    expect(screen.getByText(/payer@example.ie/)).toBeDefined();
  });

  it("says a delayed payment is still processing rather than confirming it", async () => {
    // This page is presentational only: the registration is marked paid by the
    // webhook, never by someone loading this URL.
    stripe.retrievedSessionOverrides = { payment_status: "unpaid", amount_total: 220000 };

    render(await SuccessPage({ searchParams: Promise.resolve({ session_id: "cs_test_1" }) }));

    expect(screen.getByRole("heading", { name: /Thank you!/ })).toBeDefined();
    expect(screen.getByText(/being processed/)).toBeDefined();
    expect(screen.queryByText(/Payment received/)).toBeNull();
  });

  it("offers the invoice Stripe raised alongside the payment", async () => {
    render(await SuccessPage({ searchParams: Promise.resolve({ session_id: "cs_test_1" }) }));
    const link = screen.getByRole("link", { name: /View invoice/ });

    expect(link.getAttribute("href")).toBe("https://invoice.stripe.com/i/test");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("expands the invoice in the same call rather than fetching it separately", async () => {
    await SuccessPage({ searchParams: Promise.resolve({ session_id: "cs_test_1" }) });
    const [, params] = stripe.callsTo("checkout.sessions.retrieve")[0].args as [
      string,
      { expand: string[] },
    ];

    expect(params.expand).toContain("invoice");
  });

  it("shows a generic thank-you when there is no session id at all", async () => {
    render(await SuccessPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: /Thank you!/ })).toBeDefined();
    expect(stripe.callsTo("checkout.sessions.retrieve")).toHaveLength(0);
  });

  it("does not produce an error page for a session id that no longer resolves", async () => {
    // A bad or expired id is something a payer can easily arrive with.
    stripe.failOn(
      "checkout.sessions.retrieve",
      new Error("No such checkout.session: cs_test_gone")
    );

    render(await SuccessPage({ searchParams: Promise.resolve({ session_id: "cs_test_gone" }) }));

    expect(screen.getByRole("heading", { name: /Thank you!/ })).toBeDefined();
    expect(screen.queryByText(/No such checkout/)).toBeNull();
  });

  it("offers the way back to the registration page", async () => {
    render(await SuccessPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole("link", { name: /Back to the registration page/ }).getAttribute("href")
    ).toBe("/");
  });

  it("clears the saved draft, so going home does not invite a duplicate entry", async () => {
    sessionStorage.setItem(REGISTRATION_DRAFT_KEY, JSON.stringify({ numTeams: 1, fields: {} }));

    render(await SuccessPage({ searchParams: Promise.resolve({ session_id: "cs_test_1" }) }));

    await waitFor(() =>
      expect(sessionStorage.getItem(REGISTRATION_DRAFT_KEY)).toBeNull()
    );
  });

  it("keeps the payer's amount and email out of search results", async () => {
    const { metadata } = await import("@/app/register/success/page");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
