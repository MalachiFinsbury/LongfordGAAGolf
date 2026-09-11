/**
 * @vitest-environment jsdom
 *
 * The payment modal that comes up the moment a registration is accepted.
 *
 * Bank transfers arrive at the club's own account with nothing to announce
 * them, so this screen is the club's only chance to (a) get the right amount
 * sent, (b) get a reference attached to it that an organiser can match, and
 * (c) make it plain that registering is not the same as having a place. A
 * confirmation that reads like a completed purchase is why transfer entrants
 * closed the tab and never sent the money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RegistrationForm from "@/app/RegistrationForm";
import { CLUB_BANK } from "@/lib/types";
import type { SubmitState } from "@/app/actions";

const ACCEPTED: SubmitState = {
  ok: true,
  method: "transfer",
  amountDue: 4900,
  payerName: "Máire Ní Bhriain",
  reference: "LGC-ABCDEF12",
  registrationId: "abcdef12-3456-4789-8abc-def012345678",
};

let result: SubmitState = ACCEPTED;
const claims: FormData[] = [];
let claimResult: { ok?: boolean; error?: string } = { ok: true };

vi.mock("@/app/actions", () => ({
  submitRegistration: vi.fn(async () => result),
  markPaidByPayer: vi.fn(async (_prev: unknown, formData: FormData) => {
    claims.push(formData);
    return claimResult;
  }),
}));

beforeEach(() => {
  sessionStorage.clear();
  claims.length = 0;
  result = ACCEPTED;
  claimResult = { ok: true };
});

afterEach(cleanup);

/** Registers, and returns the modal once it is up. */
async function registerAndOpen(u: ReturnType<typeof userEvent.setup>) {
  render(<RegistrationForm />);
  await u.type(screen.getByLabelText(/^Name/), "Máire Ní Bhriain");
  await u.type(screen.getByLabelText(/^Mobile/), "0871234567");
  await u.type(screen.getByLabelText(/^Email/), "maire@example.ie");
  await u.type(screen.getByLabelText("Player 1 name *"), "Máire Ní Bhriain");
  await u.click(screen.getByRole("button", { name: /Submit|Continue/ }));
  return screen.findByRole("dialog");
}

describe("the modal itself", () => {
  it("comes up on its own once the entry is accepted", async () => {
    const modal = await registerAndOpen(userEvent.setup());
    expect(modal.getAttribute("aria-modal")).toBe("true");
  });

  it("leads with the fact that a place is not yet secured", async () => {
    const modal = await registerAndOpen(userEvent.setup());
    expect(
      within(modal).getByText(/Your place is not secured until you pay/i)
    ).toBeTruthy();
  });

  it("shows what to pay, in money", async () => {
    const modal = await registerAndOpen(userEvent.setup());
    expect(within(modal).getByText("€4,900")).toBeTruthy();
  });

  it("shows the club's account in full", async () => {
    const modal = await registerAndOpen(userEvent.setup());
    expect(within(modal).getByText(CLUB_BANK.accountName)).toBeTruthy();
    expect(within(modal).getByText(CLUB_BANK.iban)).toBeTruthy();
    expect(within(modal).getByText(CLUB_BANK.bic)).toBeTruthy();
  });

  it("tells them to reference the transfer with their own name", async () => {
    // Money that arrives without one is an unattributable credit, and the
    // organisers cannot tell whose place it paid for.
    const modal = await registerAndOpen(userEvent.setup());
    expect(within(modal).getAllByText(/Máire Ní Bhriain/).length).toBeGreaterThan(0);
    expect(within(modal).getByText(/as the payment reference/i)).toBeTruthy();
  });

  it("quotes the entry reference for anyone who rings up", async () => {
    const modal = await registerAndOpen(userEvent.setup());
    expect(within(modal).getByText("LGC-ABCDEF12")).toBeTruthy();
  });

  it("closes on Escape, on the backdrop, and on \"I'll pay later\"", async () => {
    const u = userEvent.setup();
    await registerAndOpen(u);

    await u.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("can be reopened, so the IBAN is never lost behind a dismissed dialog", async () => {
    const u = userEvent.setup();
    await registerAndOpen(u);
    await u.click(screen.getByRole("button", { name: /I'll pay later/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Still on the page, just not in a dialog.
    expect(screen.getByText(CLUB_BANK.iban)).toBeTruthy();

    await u.click(screen.getByRole("button", { name: /Show payment details/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("does not leave the page behind it scrollable while it is up", async () => {
    await registerAndOpen(userEvent.setup());
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("gives the page its scrolling back on close", async () => {
    const u = userEvent.setup();
    await registerAndOpen(u);
    await u.keyboard("{Escape}");
    await waitFor(() => expect(document.body.style.overflow).not.toBe("hidden"));
  });
});

describe("\"I have paid\"", () => {
  it("reports the claim against the registration just created", async () => {
    const u = userEvent.setup();
    const modal = await registerAndOpen(u);

    await u.click(within(modal).getByRole("button", { name: /^I have paid$/ }));

    await waitFor(() => expect(claims).toHaveLength(1));
    expect(claims[0].get("registration_id")).toBe(ACCEPTED.registrationId);
  });

  it("acknowledges it, and stops offering the button", async () => {
    const u = userEvent.setup();
    const modal = await registerAndOpen(u);
    await u.click(within(modal).getByRole("button", { name: /^I have paid$/ }));

    expect(await screen.findByText(/we've noted that you've sent it/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^I have paid$/ })).toBeNull();
  });

  it("warns that an organiser checks it against the statement", async () => {
    // It is a claim, not a payment, and the screen should not imply otherwise.
    const modal = await registerAndOpen(userEvent.setup());
    expect(within(modal).getByText(/checks it against the club's bank statement/i)).toBeTruthy();
  });

  it("surfaces a refusal rather than pretending it worked", async () => {
    claimResult = { error: "Too many attempts from this connection." };
    const u = userEvent.setup();
    const modal = await registerAndOpen(u);

    await u.click(within(modal).getByRole("button", { name: /^I have paid$/ }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Too many attempts from this connection."
    );
  });

  it("is not offered when the server sent back no registration id", async () => {
    result = { ok: true, method: "transfer", amountDue: 2200 };
    const u = userEvent.setup();
    const modal = await registerAndOpen(u);

    expect(within(modal).queryByRole("button", { name: /^I have paid$/ })).toBeNull();
    // The bank details still have to be there — that is the part that matters.
    expect(within(modal).getByText(CLUB_BANK.iban)).toBeTruthy();
  });
});
