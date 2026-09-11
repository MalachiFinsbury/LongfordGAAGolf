/**
 * @vitest-environment jsdom
 *
 * What a rejected submission leaves behind.
 *
 * React 19 resets a `<form action={…}>` once its action settles, whatever the
 * result, and nothing opts out of that. Left alone it did two things to a payer
 * whose entry was refused — for a mistyped email, a rate limit, a save failure:
 *
 *   - emptied every input React does not control, which for three teams is
 *     twelve player names and handicaps on top of their own details;
 *   - put the controlled selects back to their first option while React state
 *     kept the real values, so the page read "No team" above a €4,400 total and
 *     two team blocks — and the next submit would have posted that zero.
 *
 * RegistrationForm now restores the text from the draft and the rest from
 * state. The general form behaviour lives in RegistrationForm.test.tsx; this
 * file is only about the recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RegistrationForm from "@/app/RegistrationForm";
import { REGISTRATION_DRAFT_KEY } from "@/lib/types";
import type { SubmitState } from "@/app/actions";

const REFUSED: SubmitState = {
  ok: false,
  error: "Sorry, we couldn't save your registration.",
};

let result: SubmitState = REFUSED;
const submitted: FormData[] = [];

vi.mock("@/app/actions", () => ({
  submitRegistration: vi.fn(async (_prev: SubmitState, formData: FormData) => {
    submitted.push(formData);
    return result;
  }),
}));

beforeEach(() => {
  sessionStorage.clear();
  submitted.length = 0;
  result = REFUSED;
});

afterEach(cleanup);

const nameBox = () => screen.getByLabelText(/^Name/) as HTMLInputElement;
const emailBox = () => screen.getByLabelText(/^Email/) as HTMLInputElement;
const teamsBox = () => screen.getByLabelText(/Number of teams/) as HTMLSelectElement;

function total(): string {
  return screen.getByText("Total amount due").parentElement!.querySelectorAll("span")[1]!
    .textContent!;
}

async function fillAndSubmit(u: ReturnType<typeof userEvent.setup>) {
  await u.type(nameBox(), "Máire Ní Bhriain");
  await u.type(screen.getByLabelText(/^Mobile/), "0871234567");
  await u.type(emailBox(), "maire@example.ie");
  await u.type(screen.getByLabelText("Player 1 name *"), "Máire Ní Bhriain");
  await u.click(screen.getByRole("button", { name: /Submit|Continue/ }));
  await screen.findByText(/couldn't save/);
}

describe("recovering from a rejected submission", () => {
  it("puts the payer's own details back", async () => {
    const u = userEvent.setup();
    render(<RegistrationForm />);
    await fillAndSubmit(u);

    await waitFor(() => expect(nameBox().value).toBe("Máire Ní Bhriain"));
    expect(emailBox().value).toBe("maire@example.ie");
    expect((screen.getByLabelText(/^Mobile/) as HTMLInputElement).value).toBe("0871234567");
  });

  it("puts every player back, not just the first row", async () => {
    const u = userEvent.setup();
    render(<RegistrationForm />);

    await u.selectOptions(teamsBox(), "2");
    await u.type(screen.getByLabelText("Player 1 name *"), "Máire Ní Bhriain");
    const player = document.getElementById("team_2_player_3_name") as HTMLInputElement;
    await u.type(player, "Pádraig Ó Sé");
    await u.type(nameBox(), "Máire Ní Bhriain");
    await u.type(screen.getByLabelText(/^Mobile/), "0871234567");
    await u.type(emailBox(), "maire@example.ie");
    await u.click(screen.getByRole("button", { name: /Submit|Continue/ }));
    await screen.findByText(/couldn't save/);

    await waitFor(() =>
      expect(
        (document.getElementById("team_2_player_3_name") as HTMLInputElement).value
      ).toBe("Pádraig Ó Sé")
    );
  });

  it("leaves the dropdown, the total and the team blocks all saying the same thing", async () => {
    const u = userEvent.setup();
    render(<RegistrationForm />);

    await u.selectOptions(teamsBox(), "2");
    await fillAndSubmit(u);

    await waitFor(() => expect(teamsBox().value).toBe("2"));
    expect(total()).toContain("€4,400");
    expect(screen.getAllByRole("heading", { name: /Team \d$/ })).toHaveLength(2);
  });

  it("restores the sponsorship selections and the donation", async () => {
    const u = userEvent.setup();
    render(<RegistrationForm />);

    await u.selectOptions(screen.getByLabelText("Tee box sponsorship"), "2");
    await u.selectOptions(screen.getByLabelText("Green sponsorship"), "1");
    await u.type(screen.getByLabelText("Donation amount (€)"), "75");
    await fillAndSubmit(u);

    await waitFor(() =>
      expect((screen.getByLabelText("Tee box sponsorship") as HTMLSelectElement).value).toBe("2")
    );
    expect((screen.getByLabelText("Green sponsorship") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Donation amount (€)") as HTMLInputElement).value).toBe("75");
  });

  it("keeps the raffle box ticked and its description", async () => {
    const u = userEvent.setup();
    render(<RegistrationForm />);

    await u.click(screen.getByLabelText(/sponsor a raffle prize/));
    await u.type(screen.getByLabelText(/Raffle prize/), "A case of wine");
    await fillAndSubmit(u);

    await waitFor(() =>
      expect((screen.getByLabelText(/sponsor a raffle prize/) as HTMLInputElement).checked).toBe(
        true
      )
    );
    expect((screen.getByLabelText(/Raffle prize/) as HTMLTextAreaElement).value).toBe(
      "A case of wine"
    );
  });

  it("resubmits what the payer can see, not what the reset left behind", async () => {
    // The heart of it: before, the visible page said two teams and the posted
    // form said none.
    const u = userEvent.setup();
    render(<RegistrationForm />);

    await u.selectOptions(teamsBox(), "2");
    await fillAndSubmit(u);
    await waitFor(() => expect(teamsBox().value).toBe("2"));

    result = { ok: true, method: "transfer" };
    await u.click(screen.getByRole("button", { name: /Submit|Continue/ }));
    await waitFor(() => expect(submitted).toHaveLength(2));

    const again = submitted[1];
    expect(again.get("number_of_teams")).toBe("2");
    expect(again.get("name")).toBe("Máire Ní Bhriain");
    expect(again.get("email")).toBe("maire@example.ie");
    expect(again.get("team_1_player_1_name")).toBe("Máire Ní Bhriain");
  });

  it("does not fall over when the draft is unreadable", async () => {
    const u = userEvent.setup();
    render(<RegistrationForm />);
    await fillAndSubmit(u);

    sessionStorage.setItem(REGISTRATION_DRAFT_KEY, "{not json");
    result = REFUSED;
    await u.click(screen.getByRole("button", { name: /Submit|Continue/ }));

    // Still a working form showing the refusal, rather than a crashed render.
    await waitFor(() => expect(submitted).toHaveLength(2));
    expect(screen.getByText(/couldn't save/)).toBeTruthy();
    expect(teamsBox()).toBeTruthy();
  });
});
