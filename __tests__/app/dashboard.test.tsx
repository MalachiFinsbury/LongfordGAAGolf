/**
 * @vitest-environment jsdom
 *
 * The organisers' dashboard.
 *
 * This is the screen someone works from with a registrant on the phone, and the
 * one the club's money figures are read off. What is tested here is what would
 * actually mislead them: totals that count the wrong rows, a search that hides
 * someone, an export that opens as a formula, or a "mark as paid" button
 * offered on a payment Stripe already settled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dashboard from "@/app/admin/Dashboard";
import { registration, team } from "../helpers/factories";
import type { Registration } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions", () => ({
  logout: vi.fn(),
  markRegistrationPaid: vi.fn(async () => ({ ok: true })),
  revertRegistrationToPending: vi.fn(async () => ({ ok: true })),
}));

/** Blobs handed to `download`, newest last. */
let downloads: Blob[] = [];

/** The CSV most recently exported. */
function lastCsv(): Promise<string> {
  const blob = downloads.at(-1);
  expect(blob, "nothing was exported").toBeDefined();
  return blob!.text();
}

beforeEach(() => {
  downloads = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      downloads.push(blob);
      return "blob:mock";
    },
    revokeObjectURL: () => {},
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(cleanup);

const paid = registration({
  name: "Aoife Ní Ruairc",
  company_or_club: "Longford Slashers",
  email: "aoife@example.ie",
  mobile: "0871111111",
  number_of_teams: 1,
  teams: [team(["Aoife Ní Ruairc", "Cormac Ó Baoill"], ["10", "14"])],
  total_amount: 2200,
  payment_method: "card",
  payment_status: "paid",
  amount_paid: 2200,
  paid_at: "2026-09-02T10:00:00.000Z",
  payment_recorded_by: "stripe",
  created_at: "2026-09-02T09:00:00.000Z",
});

const awaitingTransfer = registration({
  name: "Brian Mac Gabhann",
  company_or_club: null,
  email: "brian@example.ie",
  mobile: "0872222222",
  number_of_teams: 2,
  teams: [team(["Brian Mac Gabhann"]), team(["Niamh de Búrca"])],
  tee_box_count: 1,
  total_amount: 4900,
  payment_method: "transfer",
  payment_status: "pending",
  created_at: "2026-09-03T09:00:00.000Z",
});

const abandoned = registration({
  name: "Ciara Ní Loingsigh",
  email: "ciara@example.ie",
  mobile: "0873333333",
  number_of_teams: 1,
  teams: [team([])],
  total_amount: 2200,
  payment_method: "card",
  payment_status: "expired",
  created_at: "2026-09-01T09:00:00.000Z",
});

const recordedByHand = registration({
  name: "Dara Ó Sé",
  email: "dara@example.ie",
  mobile: "0874444444",
  number_of_teams: 1,
  teams: [team(["Dara Ó Sé"])],
  total_amount: 2200,
  payment_method: "transfer",
  payment_status: "paid",
  amount_paid: 2000,
  paid_at: "2026-09-04T10:00:00.000Z",
  payment_recorded_by: "organiser",
  payment_note: "AIB ref 55123",
  created_at: "2026-09-04T09:00:00.000Z",
});

const claimsToHavePaid = registration({
  name: "Eimear Ní Chonaill",
  email: "eimear@example.ie",
  mobile: "0875555555",
  number_of_teams: 1,
  teams: [team(["Eimear Ní Chonaill"])],
  total_amount: 2200,
  payment_method: "transfer",
  payment_status: "pending",
  payer_claimed_paid_at: "2026-09-05T14:30:00.000Z",
  created_at: "2026-09-05T09:00:00.000Z",
});

const ALL = [recordedByHand, awaitingTransfer, paid, abandoned];

function show(rows: Registration[] = ALL) {
  return render(<Dashboard registrations={rows} />);
}

/** The stat tile under `label`. */
function stat(label: string): string {
  const heading = screen.getByText(label);
  return heading.parentElement!.querySelectorAll("p")[1]!.textContent ?? "";
}

describe("dashboard — the money figures", () => {
  it("counts collected from what actually arrived, not what was pledged", () => {
    show();
    // 2200 settled by Stripe + 2000 an organiser recorded (not the 2200 due).
    expect(stat("Collected")).toBe("€4,200");
  });

  it("leaves abandoned checkouts out of the outstanding total", () => {
    // Nobody owes anything on a checkout they walked away from; counting it
    // would inflate the figure the organisers treat as their chase-up list.
    show();
    expect(stat("Outstanding")).toBe("€4,900");
  });

  it("separates what Stripe confirmed from what a volunteer typed in", () => {
    show();
    expect(
      screen.getByText(/€2,200 confirmed by Stripe, €2,000 recorded by an organiser/)
    ).toBeTruthy();
  });

  it("says so plainly when every figure came from Stripe", () => {
    show([paid, awaitingTransfer]);
    expect(screen.getByText(/Every figure here has been confirmed by Stripe/)).toBeTruthy();
  });

  it("counts teams and the places they imply", () => {
    show();
    expect(stat("Teams")).toBe("5");
    expect(screen.getByText("20 places")).toBeTruthy();
  });

  it("counts only players who were actually named", () => {
    show();
    // Aoife 2, Brian 2, Dara 1, Ciara 0.
    expect(stat("Players named")).toBe("5");
  });
});

describe("dashboard — finding someone", () => {
  it("finds a registrant by name", async () => {
    show();
    await userEvent.type(screen.getByLabelText("Search registrations"), "Brian");

    expect(screen.getByText("Brian Mac Gabhann")).toBeTruthy();
    expect(screen.queryByText("Aoife Ní Ruairc")).toBeNull();
  });

  it("finds a registrant by the name of a player they entered", async () => {
    // The person on the phone is often not the person who filled in the form.
    show();
    await userEvent.type(screen.getByLabelText("Search registrations"), "Niamh de Búrca");

    expect(screen.getByText("Brian Mac Gabhann")).toBeTruthy();
    expect(screen.queryByText("Dara Ó Sé")).toBeNull();
  });

  it("finds a registrant by phone number and by club", async () => {
    show();
    const search = screen.getByLabelText("Search registrations");

    await userEvent.type(search, "0873333333");
    expect(screen.getByText("Ciara Ní Loingsigh")).toBeTruthy();

    await userEvent.clear(search);
    await userEvent.type(search, "Slashers");
    expect(screen.getByText("Aoife Ní Ruairc")).toBeTruthy();
  });

  it("narrows the totals to the rows on screen", async () => {
    // Filter to the chase-up list and "outstanding" should be what that list is
    // worth, not what the whole event is worth.
    show();
    await userEvent.click(screen.getByRole("button", { name: /^Awaiting/ }));

    expect(stat("Outstanding")).toBe("€4,900");
    expect(stat("Collected")).toBe("€0");
  });

  it("offers a way back when the filters match nothing", async () => {
    show();
    await userEvent.type(screen.getByLabelText("Search registrations"), "nobody at all");

    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();
    await userEvent.click(screen.getAllByText("Reset filters")[0]);
    expect(screen.getByText("Aoife Ní Ruairc")).toBeTruthy();
  });

  it("says nothing has come in yet rather than showing an empty grid", () => {
    show([]);
    expect(screen.getByText(/No registrations yet/)).toBeTruthy();
  });
});

describe("dashboard — recording a bank transfer", () => {
  async function openCard(name: string) {
    await userEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  }

  it("offers the form on a registration still awaiting payment", async () => {
    show();
    await openCard("Brian Mac Gabhann");

    expect(screen.getByText("Money arrived by bank transfer?")).toBeTruthy();
    // Pre-filled with what is due, so the common case is one click.
    expect(screen.getByLabelText("Amount received")).toHaveProperty("value", "4900");
  });

  it("offers nothing to unpick on a payment Stripe settled", async () => {
    // Not merely hidden as a courtesy — that money genuinely arrived.
    show();
    await openCard("Aoife Ní Ruairc");

    expect(screen.queryByText("Money arrived by bank transfer?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers an undo on a figure an organiser recorded, and labels it as theirs", async () => {
    show();
    await openCard("Dara Ó Sé");

    expect(screen.getByText(/Recorded by an organiser — not confirmed by Stripe/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getByText(/AIB ref 55123/)).toBeTruthy();
  });

  it("flags a part payment as short rather than showing it as settled", async () => {
    show();
    await openCard("Dara Ó Sé");
    expect(screen.getByText("(€200 short)")).toBeTruthy();
  });

  it("still lets an abandoned checkout be recorded by hand", async () => {
    // They may well have paid by transfer after giving up on the card form.
    show();
    await openCard("Ciara Ní Loingsigh");
    expect(screen.getByText("Money arrived by bank transfer?")).toBeTruthy();
  });
});

describe("dashboard — exporting", () => {
  it("exports the rows currently on screen, not the whole table", async () => {
    show();
    await userEvent.type(screen.getByLabelText("Search registrations"), "Brian");
    await userEvent.click(screen.getByText("Export CSV"));

    const csv = await lastCsv();
    expect(csv).toContain("Brian Mac Gabhann");
    expect(csv).not.toContain("Aoife Ní Ruairc");
  });

  it("exports one row per player in the players view", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "players" }));
    await userEvent.click(screen.getByText("Export CSV"));

    const lines = (await lastCsv()).trim().split("\n");
    expect(lines[0]).toContain("Player,Handicap,Team");
    expect(lines).toHaveLength(6); // header + 5 named players
  });

  it("neutralises a cell a spreadsheet would execute", async () => {
    // The raffle prize box is free text typed by the public, so an export
    // opened on an organiser's laptop is a code path starting at a stranger's
    // keyboard.
    show([
      registration({
        name: "=cmd|'/c calc'!A1",
        sponsor_raffle: true,
        raffle_prize: "+HYPERLINK(\"http://evil\")",
      }),
    ]);
    await userEvent.click(screen.getByText("Export CSV"));

    const csv = await lastCsv();
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+HYPERLINK");
  });

  it("keeps genuine amounts numeric so they still add up", async () => {
    show([paid]);
    await userEvent.click(screen.getByText("Export CSV"));
    expect(await lastCsv()).toMatch(/,2200,/);
  });

  it("leads with a BOM so Excel does not mangle the euro sign", async () => {
    show([paid]);
    await userEvent.click(screen.getByText("Export CSV"));

    // Checked as bytes: decoding as text strips the mark, which is exactly the
    // job it does for Excel too.
    const bytes = new Uint8Array(await downloads.at(-1)!.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("puts the anchor in the document before clicking it", async () => {
    // Firefox ignores a click on a detached anchor, which made the export
    // silently do nothing there.
    let attached = false;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      attached = this.isConnected;
    });

    show([paid]);
    await userEvent.click(screen.getByText("Export CSV"));
    expect(attached).toBe(true);
  });
});

describe("dashboard — views", () => {
  it("lists every named player across registrations", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "players" }));

    expect(screen.getByText("5 players named across 4 registrations.")).toBeTruthy();
    expect(screen.getByText("Niamh de Búrca")).toBeTruthy();
  });

  it("narrows the players view to the matching players, not their team-mates", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "players" }));
    await userEvent.type(screen.getByLabelText("Search registrations"), "Niamh");

    // Brian still appears as the registrant who entered her — what must not
    // happen is his own row, and their other team-mates, coming along too.
    expect(screen.getByText("Niamh de Búrca")).toBeTruthy();
    expect(screen.getByText(/^1 player named across/)).toBeTruthy();
  });

  it("shows the same registrations as a table", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "table" }));

    const table = screen.getByRole("table");
    expect(within(table).getByText("Brian Mac Gabhann")).toBeTruthy();
    expect(within(table).getByText("Aoife Ní Ruairc")).toBeTruthy();
  });
});

describe("dashboard — the payer's own word", () => {
  async function openCard(name: string) {
    await userEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  }

  it("flags it on the card without needing the row expanded", async () => {
    // The chase-up list is worked top to bottom; someone who says they have
    // paid is the one worth checking the statement for first.
    show([claimsToHavePaid]);
    expect(screen.getByText(/payer says paid/i)).toBeTruthy();
  });

  it("shows when they said it, once expanded", async () => {
    show([claimsToHavePaid]);
    await openCard("Eimear Ní Chonaill");
    expect(screen.getByText(/They have paid — 5 Sept 2026/)).toBeTruthy();
  });

  it("prompts beside the button an organiser is about to press", async () => {
    show([claimsToHavePaid]);
    await openCard("Eimear Ní Chonaill");
    expect(screen.getByText(/worth checking the statement/i)).toBeTruthy();
  });

  it("counts for nothing in the money figures", async () => {
    // The load-bearing one. A claim is unverified — anyone can press that
    // button — so it must never reach a total the club acts on.
    show([claimsToHavePaid]);
    expect(stat("Collected")).toBe("€0");
    expect(stat("Outstanding")).toBe("€2,200");
  });

  it("still shows as awaiting payment, not paid", async () => {
    show([claimsToHavePaid]);
    expect(screen.getByText(/Awaiting payment/)).toBeTruthy();
  });

  it("stops being mentioned once the payment is actually recorded", async () => {
    show([
      registration({
        ...claimsToHavePaid,
        payment_status: "paid",
        amount_paid: 2200,
        payment_recorded_by: "organiser",
      }),
    ]);
    await openCard("Eimear Ní Chonaill");
    expect(screen.queryByText(/They have paid —/)).toBeNull();
  });

  it("goes into the export, so it can be reconciled in a spreadsheet", async () => {
    show([claimsToHavePaid]);
    await userEvent.click(screen.getByText("Export CSV"));

    const csv = await lastCsv();
    expect(csv.split(/\r?\n/)[0]).toContain("Payer says paid");
    expect(csv).toMatch(/5 Sept 2026/);
  });
});
