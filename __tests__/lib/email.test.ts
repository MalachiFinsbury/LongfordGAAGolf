/**
 * Transactional email.
 *
 * Two things matter here beyond "the right words came out". Registrant-supplied
 * text goes into HTML, so it must be escaped; and nothing in the module may
 * throw, because every caller has already done the thing the email is merely
 * reporting — a payment Stripe settled, a registration already in the database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reference, sendPaidConfirmation, sendTransferInstructions } from "@/lib/email";
import type { EntrySummary } from "@/lib/email";
import { CLUB_BANK } from "@/lib/types";
import { team } from "../helpers/factories";

type SentMessage = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
};

let sent: SentMessage[] = [];
let respond: () => Response | Promise<Response>;

function entry(overrides: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: "abcdef12-3456-4789-8abc-def012345678",
    name: "Máire Ní Bhriain",
    company_or_club: "Longford Slashers",
    address: "1 Main Street, Longford",
    email: "maire@example.ie",
    mobile: "0871234567",
    number_of_teams: 1,
    teams: [team(["Máire Ní Bhriain", "Seán Ó Conaill"], ["12", "8"])],
    tee_box_count: 0,
    green_count: 0,
    donation_amount: 0,
    sponsor_raffle: false,
    raffle_prize: null,
    total_amount: 2200,
    payment_method: "transfer",
    ...overrides,
  };
}

/** The message addressed to the payer, as opposed to the organisers' alert. */
function toPayer(): SentMessage {
  const msg = sent.find((m) => m.to.includes("maire@example.ie"));
  expect(msg, "no message was addressed to the payer").toBeDefined();
  return msg!;
}

function toOrganisers(): SentMessage {
  const msg = sent.find((m) => m.to.includes("one@club.ie"));
  expect(msg, "no message was addressed to the organisers").toBeDefined();
  return msg!;
}

beforeEach(() => {
  sent = [];
  // These paths log loudly on purpose; keep the noise out of the run, and
  // assert it where the swallowing is under test.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  respond = () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as SentMessage);
    return respond();
  });
});

describe("reference", () => {
  it("is a short, quotable handle derived from the row id", () => {
    expect(reference("abcdef12-3456-4789-8abc-def012345678")).toBe("LGC-ABCDEF12");
  });
});

describe("sendTransferInstructions", () => {
  it("sends the payer the club's account details and the amount due", async () => {
    await sendTransferInstructions(entry({ total_amount: 2700 }));

    const msg = toPayer();
    expect(msg.subject).toMatch(/payment details inside/i);
    expect(msg.html).toContain(CLUB_BANK.iban);
    expect(msg.html).toContain(CLUB_BANK.bic);
    expect(msg.html).toContain(CLUB_BANK.accountName);
    expect(msg.text).toContain(CLUB_BANK.iban);
    // The IBAN on screen and the IBAN in the email are the same constant; an
    // amount that disagreed between them is a payment that never arrives.
    expect(msg.html).toContain("€2,700");
    expect(msg.text).toContain("€2,700");
  });

  it("tells the payer what reference to quote", async () => {
    await sendTransferInstructions(entry());
    expect(toPayer().text).toContain("Máire Ní Bhriain");
    expect(toPayer().text).toContain(reference(entry().id));
  });

  it("alerts the organisers that nothing has been collected yet", async () => {
    await sendTransferInstructions(entry());

    const msg = toOrganisers();
    expect(msg.subject).toMatch(/^Awaiting transfer:/);
    expect(msg.to).toEqual(["one@club.ie", "two@club.ie"]);
    // So an organiser can answer the registrant straight from the alert.
    expect(msg.reply_to).toBe("maire@example.ie");
    expect(msg.text).toMatch(/watch for a transfer/i);
  });

  it("itemises the order and the roster", async () => {
    await sendTransferInstructions(
      entry({
        number_of_teams: 2,
        tee_box_count: 1,
        green_count: 1,
        donation_amount: 150,
        total_amount: 5550,
        teams: [team(["Máire Ní Bhriain"]), team(["Pádraig Ó Sé", "Áine Ó Dónaill"])],
      })
    );

    const { text } = toPayer();
    expect(text).toContain("2 × team entry (4 players)");
    expect(text).toContain("1 × tee box sponsorship");
    expect(text).toContain("1 × green sponsorship");
    expect(text).toContain("Donation");
    expect(text).toContain("TOTAL: €5,550");
    expect(text).toContain("Team 1: Máire Ní Bhriain");
    expect(text).toContain("Team 2: Pádraig Ó Sé");
  });

  it("mentions a pledged raffle prize", async () => {
    await sendTransferInstructions(
      entry({ sponsor_raffle: true, raffle_prize: "A case of wine" })
    );
    expect(toPayer().html).toContain("A case of wine");
    expect(toOrganisers().text).toContain("A case of wine");
  });
});

describe("sendPaidConfirmation", () => {
  it("confirms the amount that actually settled, not the amount due", async () => {
    // A part payment is still a payment; telling the payer they paid the full
    // amount would hide the shortfall from both sides.
    await sendPaidConfirmation(entry({ total_amount: 2200 }), 1100);

    const msg = toPayer();
    expect(msg.subject).toMatch(/entry is confirmed/i);
    expect(msg.html).toContain("€1,100");
    expect(msg.text).toContain("€1,100");
  });

  it("alerts the organisers by default", async () => {
    await sendPaidConfirmation(entry(), 2200);
    expect(toOrganisers().subject).toMatch(/^Paid:/);
  });

  it("stays quiet when an organiser recorded the payment themselves", async () => {
    // They are sitting in the dashboard having just clicked the button.
    await sendPaidConfirmation(entry(), 2200, { notifyOrganisers: false });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["maire@example.ie"]);
  });
});

describe("escaping", () => {
  it("escapes registrant-supplied text before it reaches the HTML body", async () => {
    await sendTransferInstructions(
      entry({
        name: '<script>alert("xss")</script>',
        company_or_club: "O'Brien & Sons <b>Ltd</b>",
        sponsor_raffle: true,
        raffle_prize: "<img src=x onerror=alert(1)>",
        teams: [team(["<b>Player</b>"])],
      })
    );

    for (const msg of sent) {
      // No registrant-supplied markup survives as markup. The escaped text may
      // well still read "onerror=" — harmless once the brackets are entities.
      expect(msg.html).not.toContain("<script>");
      expect(msg.html).not.toContain("<img");
      expect(msg.html).not.toContain("<b>Ltd</b>");
      expect(msg.html).not.toContain("<b>Player</b>");
      expect(msg.html).toContain("&lt;script&gt;");
      expect(msg.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }

    // The club name only appears on the organisers' alert, so check the
    // ampersand there rather than in the loop above.
    expect(toOrganisers().html).toContain("O&#39;Brien &amp; Sons");
  });

  it("escapes the email address in the organisers' mailto link", async () => {
    await sendTransferInstructions(entry({ email: 'a"onmouseover="x@example.ie' }));
    expect(toOrganisers().html).not.toContain('"onmouseover="');
  });
});

describe("configuration", () => {
  it("is a no-op when no sending key is configured", async () => {
    // Local development and previews exercise the registration flow without
    // holding a live Resend key.
    vi.stubEnv("RESEND_API_KEY", "");
    await sendTransferInstructions(entry());
    expect(sent).toHaveLength(0);
  });

  it("skips the organiser alert when no organisers are listed", async () => {
    vi.stubEnv("ORGANISER_EMAILS", "");
    await sendTransferInstructions(entry());

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["maire@example.ie"]);
  });

  it("sends from the configured address", async () => {
    await sendTransferInstructions(entry());
    expect(sent[0].from).toBe("Golf Classic <noreply@club.ie>");
  });
});

describe("the no-throw guarantee", () => {
  it("survives a rejected send", async () => {
    // The caller has already saved the registration or recorded the payment.
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });

    await expect(sendTransferInstructions(entry())).resolves.toBeUndefined();
    await expect(sendPaidConfirmation(entry(), 2200)).resolves.toBeUndefined();
    // Swallowed, but not silently — this is the only trace an organiser has
    // that a payer was never written to.
    expect(console.error).toHaveBeenCalled();
  });

  it("survives an error response from Resend", async () => {
    respond = () => new Response('{"message":"domain not verified"}', { status: 403 });
    await expect(sendPaidConfirmation(entry(), 2200)).resolves.toBeUndefined();
  });

  it("survives a row whose shape is not what the renderer expects", async () => {
    // This is the half `send` never covered: every message is rendered from
    // registrant data before a request is made, and a throw there used to
    // escape — turning a recorded payment into a 500 that Stripe then retried.
    const malformed = {
      ...entry(),
      teams: [{ players: [{ get name() { throw new Error("bad row"); } }] }],
    } as unknown as EntrySummary;

    await expect(sendTransferInstructions(malformed)).resolves.toBeUndefined();
    await expect(sendPaidConfirmation(malformed, 2200)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to send"),
      expect.any(Error)
    );
  });

  it("survives an id too short to build a reference from", async () => {
    await expect(
      sendPaidConfirmation(entry({ id: "" }), 2200)
    ).resolves.toBeUndefined();
  });
});
