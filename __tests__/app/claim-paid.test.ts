/**
 * "I have paid" — the payer's own word, from the confirmation modal.
 *
 * The endpoint behind that button is public: the payer has no login, and the
 * only thing identifying them is a registration id their own browser was just
 * handed. So the whole point of these tests is what the button must NOT be able
 * to do. A claim is a prompt to go and read the bank statement; if it could
 * move `payment_status` or `amount_paid`, it would be a self-service "mark my
 * own entry paid" control on a public page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../helpers/supabase";
import { FakeCookieStore, fakeHeaders, redirectDouble } from "../helpers/next";
import { registration, uuid } from "../helpers/factories";
import type { Registration } from "@/lib/types";

const db = new FakeSupabase();
let cookieStore = new FakeCookieStore();

vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => fakeHeaders({ "x-forwarded-for": "89.100.1.1" }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectDouble }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getAdminClient: () => db }));
vi.mock("@/lib/payments", () => ({
  createCheckoutSession: vi.fn(),
  createAndSendInvoice: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendTransferInstructions: vi.fn(async () => {}),
  sendPaidConfirmation: vi.fn(async () => {}),
}));

const { markPaidByPayer } = await import("@/app/actions");
const { revalidatePath } = await import("next/cache");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function seed(overrides: Partial<Registration> = {}): Registration {
  const row = registration({ payment_method: "transfer", ...overrides });
  db.seed("registrations", [row as unknown as Record<string, unknown>]);
  return row;
}

const saved = (id: string) => db.row<Registration>("registrations", id)!;

beforeEach(() => {
  db.reset();
  cookieStore = new FakeCookieStore();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("markPaidByPayer — recording the claim", () => {
  it("timestamps the claim", async () => {
    const row = seed();
    const state = await markPaidByPayer({}, form({ registration_id: row.id }));

    expect(state).toEqual({ ok: true });
    expect(saved(row.id).payer_claimed_paid_at).toBeTruthy();
  });

  it("refreshes the dashboard, so an organiser sees it without reloading", async () => {
    const row = seed();
    await markPaidByPayer({}, form({ registration_id: row.id }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it("is idempotent enough to survive a double click", async () => {
    const row = seed();
    await markPaidByPayer({}, form({ registration_id: row.id }));
    const first = saved(row.id).payer_claimed_paid_at;
    const second = await markPaidByPayer({}, form({ registration_id: row.id }));

    expect(second).toEqual({ ok: true });
    expect(saved(row.id).payer_claimed_paid_at).toBeTruthy();
    expect(typeof first).toBe("string");
  });
});

describe("markPaidByPayer — what it must not do", () => {
  it("does not mark the registration paid", async () => {
    // The load-bearing test. Anyone can reach this endpoint.
    const row = seed();
    await markPaidByPayer({}, form({ registration_id: row.id }));

    const after = saved(row.id);
    expect(after.payment_status).toBe("pending");
    expect(Number(after.amount_paid)).toBe(0);
    expect(after.paid_at).toBeNull();
    expect(after.payment_recorded_by).toBeNull();
  });

  it("does not touch a payment Stripe already settled", async () => {
    const row = seed({
      payment_status: "paid",
      amount_paid: 2200,
      payment_recorded_by: "stripe",
    });

    const state = await markPaidByPayer({}, form({ registration_id: row.id }));

    // Thanked either way — the payer is not the audience for the club's
    // bookkeeping — but nothing is written.
    expect(state).toEqual({ ok: true });
    expect(saved(row.id).payer_claimed_paid_at).toBeNull();
    expect(Number(saved(row.id).amount_paid)).toBe(2200);
  });

  it("does not reopen a payment an organiser already reconciled", async () => {
    const row = seed({
      payment_status: "paid",
      amount_paid: 2200,
      payment_recorded_by: "organiser",
    });

    await markPaidByPayer({}, form({ registration_id: row.id }));
    expect(saved(row.id).payer_claimed_paid_at).toBeNull();
  });

  it("cannot be aimed at a row by way of a malformed id", async () => {
    seed();
    for (const id of ["", "1 or 1=1", "../../etc/passwd", "not-a-uuid"]) {
      const state = await markPaidByPayer({}, form({ registration_id: id }));
      expect(state.error).toMatch(/couldn't identify/i);
    }
  });

  it("says nothing about whether an id exists", async () => {
    // A well-formed id that matches nothing gets the same answer as one that
    // does, so the endpoint cannot be used to confirm a guess.
    const real = seed();
    const hit = await markPaidByPayer({}, form({ registration_id: real.id }));
    const miss = await markPaidByPayer({}, form({ registration_id: uuid() }));
    expect(miss).toEqual(hit);
  });
});

describe("markPaidByPayer — abuse", () => {
  it("is rate limited like the form it sits behind", async () => {
    db.onRpc("bump_rate_limit", () => ({ data: 11, error: null }));
    const row = seed();

    const state = await markPaidByPayer({}, form({ registration_id: row.id }));

    expect(state.error).toMatch(/too many attempts/i);
    expect(saved(row.id).payer_claimed_paid_at).toBeNull();
  });

  it("charges its own budget, not the registration form's", async () => {
    db.onRpc("bump_rate_limit", () => ({ data: 1, error: null }));
    const row = seed();

    await markPaidByPayer({}, form({ registration_id: row.id }));
    expect(String(db.rpcCalls[0].args.p_key)).toMatch(/^claim-paid:/);
  });

  it("reports a database failure without leaking it", async () => {
    const row = seed();
    db.failOnce("registrations", "update", { message: 'column "payer_claimed_paid_at" missing' });

    const state = await markPaidByPayer({}, form({ registration_id: row.id }));

    expect(state.error).toMatch(/couldn't record that/i);
    expect(state.error).not.toMatch(/column|payer_claimed/);
  });
});
