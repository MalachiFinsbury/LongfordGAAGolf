/**
 * Transactional email for registrations.
 *
 * Sent through Resend's REST API directly rather than its SDK: this app sends
 * two shapes of message from two places, so one `fetch` beats carrying a
 * dependency, and it keeps the module runtime-agnostic.
 *
 * Nothing in here throws, by design. An email is a courtesy layered on top of
 * something that has already happened — a payment Stripe confirmed, or a
 * registration already written to the database. Losing one must never fail the
 * entry, and above all must never make the Stripe webhook return non-2xx:
 * Stripe would retry, and the retry would re-send the very message that just
 * failed. Failures are logged loudly and swallowed.
 */

// Explicit .ts extension, as in catalog.ts and payments.ts: it lets this module
// be exercised directly under Node's type stripping, which resolves as strict
// ESM and needs the real filename.
import {
  CLUB_BANK,
  PRICE_PER_GREEN,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  formatEuro,
  type PaymentMethod,
  type Team,
} from "./types.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const EVENT_NAME = "Longford GAA Golf Classic 2026";
const EVENT_WHERE = "Killeen Castle, Co. Meath";
const EVENT_WHEN = "Friday 18 September 2026";

const GREEN = "#0f5228";
const GOLD = "#f2b705";

/**
 * The parts of a registration an email needs. Deliberately a structural subset
 * of `Registration` rather than the whole row, so the server action can pass
 * what it just built and the webhook can pass what it just read back, without
 * either having to fabricate payment columns the other one owns.
 */
export type EntrySummary = {
  id: string;
  name: string;
  company_or_club: string | null;
  address: string | null;
  email: string;
  mobile: string;
  number_of_teams: number;
  teams: Team[];
  tee_box_count: number;
  green_count: number;
  donation_amount: number;
  sponsor_raffle: boolean;
  raffle_prize: string | null;
  total_amount: number;
  payment_method: PaymentMethod;
};

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

function organiserRecipients(): string[] {
  return (process.env.ORGANISER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type SendArgs = {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

async function send({ to, subject, html, text, replyTo }: SendArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  // Absent configuration is a no-op rather than an error: local development
  // and preview deployments should not have to hold a live sending key to
  // exercise the registration flow.
  if (!apiKey || !from) {
    console.warn(`[email] RESEND_API_KEY or EMAIL_FROM unset — not sending "${subject}"`);
    return;
  }
  if (to.length === 0) {
    console.warn(`[email] no recipients for "${subject}" — nothing to do`);
    return;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!res.ok) {
      // The body, not just the status. Resend puts the actionable part —
      // unverified domain, malformed address, rate limit — in the payload.
      console.error(
        `[email] send failed ${res.status} for "${subject}":`,
        await res.text().catch(() => "(no body)")
      );
    }
  } catch (e) {
    console.error(`[email] send threw for "${subject}"`, e);
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Registrant-supplied text goes into HTML, so it gets escaped without exception. */
function esc(value: string | null | undefined): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/** Short, quotable handle for phone calls and bank references. */
export function reference(id: string): string {
  return `LGC-${id.slice(0, 8).toUpperCase()}`;
}

function orderRows(e: EntrySummary): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (e.number_of_teams > 0) {
    rows.push([
      `${e.number_of_teams} × team entry (4 players)`,
      formatEuro(e.number_of_teams * PRICE_PER_TEAM),
    ]);
  }
  if (e.tee_box_count > 0) {
    rows.push([
      `${e.tee_box_count} × tee box sponsorship`,
      formatEuro(e.tee_box_count * PRICE_PER_TEE_BOX),
    ]);
  }
  if (e.green_count > 0) {
    rows.push([
      `${e.green_count} × green sponsorship`,
      formatEuro(e.green_count * PRICE_PER_GREEN),
    ]);
  }
  if (Number(e.donation_amount) > 0) {
    rows.push(["Donation", formatEuro(Number(e.donation_amount))]);
  }
  return rows;
}

type RosterLine = { team: number; name: string; handicap: string };

function roster(e: EntrySummary): RosterLine[] {
  const teams = Array.isArray(e.teams) ? e.teams : [];
  const out: RosterLine[] = [];
  teams.forEach((team, ti) => {
    (team?.players ?? []).forEach((p) => {
      if (p?.name) out.push({ team: ti + 1, name: p.name, handicap: p.handicap ?? "" });
    });
  });
  return out;
}

function orderTableHtml(e: EntrySummary): string {
  const rows = orderRows(e)
    .map(
      ([label, amount]) =>
        `<tr><td style="padding:4px 0;color:#444">${esc(label)}</td>` +
        `<td style="padding:4px 0;text-align:right;color:#111">${esc(amount)}</td></tr>`
    )
    .join("");

  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows}
    <tr><td style="padding:8px 0 0;border-top:1px solid #ddd;font-weight:bold">Total</td>
        <td style="padding:8px 0 0;border-top:1px solid #ddd;text-align:right;font-weight:bold;color:${GREEN}">
          ${esc(formatEuro(Number(e.total_amount)))}</td></tr>
  </table>`;
}

function rosterHtml(e: EntrySummary): string {
  const lines = roster(e);
  if (lines.length === 0) return "";

  const byTeam = new Map<number, RosterLine[]>();
  for (const l of lines) byTeam.set(l.team, [...(byTeam.get(l.team) ?? []), l]);

  const blocks = [...byTeam.entries()]
    .map(
      ([team, players]) =>
        `<p style="margin:12px 0 4px;font-size:12px;font-weight:bold;color:${GREEN};text-transform:uppercase">Team ${team}</p>` +
        `<ul style="margin:0;padding-left:18px;font-size:14px;color:#333">` +
        players
          .map(
            (p) =>
              `<li>${esc(p.name)}${p.handicap ? ` <span style="color:#888">(h/c ${esc(p.handicap)})</span>` : ""}</li>`
          )
          .join("") +
        `</ul>`
    )
    .join("");

  return `<h3 style="margin:24px 0 0;font-size:14px;color:#111">Players</h3>${blocks}`;
}

function extrasHtml(e: EntrySummary): string {
  if (!e.sponsor_raffle) return "";
  return `<p style="margin:16px 0 0;padding:10px;background:#fdf6e0;border-radius:6px;font-size:13px;color:#5a4600">
    <strong>Raffle prize offered:</strong> ${esc(e.raffle_prize || "no description given")}
  </p>`;
}

function shell(headline: string, accent: string, body: string): string {
  return `<div style="margin:0;padding:24px 12px;background:#f4f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7e5">
    <div style="padding:20px 24px;background:${GREEN}">
      <p style="margin:0;font-size:11px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${GOLD}">Longford GAA</p>
      <h1 style="margin:6px 0 0;font-size:19px;color:#fff">${esc(headline)}</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#cfe3d5">${esc(accent)}</p>
    </div>
    <div style="padding:24px">${body}</div>
    <div style="padding:16px 24px;background:#fafbfa;border-top:1px solid #eee;font-size:12px;color:#777">
      ${esc(EVENT_NAME)} · ${esc(EVENT_WHERE)} · ${esc(EVENT_WHEN)}
    </div>
  </div>
</div>`;
}

function orderTableText(e: EntrySummary): string {
  const rows = orderRows(e).map(([l, a]) => `  ${l}: ${a}`);
  rows.push(`  TOTAL: ${formatEuro(Number(e.total_amount))}`);
  return rows.join("\n");
}

function rosterText(e: EntrySummary): string {
  const lines = roster(e);
  if (lines.length === 0) return "";
  return (
    "\nPlayers\n" +
    lines
      .map((p) => `  Team ${p.team}: ${p.name}${p.handicap ? ` (h/c ${p.handicap})` : ""}`)
      .join("\n")
  );
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

function payerPaid(e: EntrySummary, amountPaid: number) {
  const ref = reference(e.id);
  return {
    subject: `Your ${EVENT_NAME} entry is confirmed`,
    html: shell(
      "Entry confirmed",
      `${formatEuro(amountPaid)} received — thank you`,
      `<p style="margin:0;font-size:15px;color:#333">Hello ${esc(e.name)},</p>
       <p style="margin:12px 0 0;font-size:14px;color:#444">
         We've received your payment of <strong>${esc(formatEuro(amountPaid))}</strong>.
         Your place at the ${esc(EVENT_NAME)} is secured.
       </p>
       <p style="margin:12px 0 0;font-size:13px;color:#666">Your reference is <strong>${esc(ref)}</strong> — quote it if you get in touch.</p>
       <h3 style="margin:24px 0 8px;font-size:14px;color:#111">What you booked</h3>
       ${orderTableHtml(e)}
       ${rosterHtml(e)}
       ${extrasHtml(e)}
       <p style="margin:24px 0 0;font-size:14px;color:#444">
         We'll be in touch about tee times closer to the day. If any player details change,
         just reply to this email.
       </p>`
    ),
    text: `Hello ${e.name},

We've received your payment of ${formatEuro(amountPaid)}. Your place at the ${EVENT_NAME} is secured.

Reference: ${ref}

What you booked
${orderTableText(e)}
${rosterText(e)}
${e.sponsor_raffle ? `\nRaffle prize offered: ${e.raffle_prize || "no description given"}\n` : ""}
We'll be in touch about tee times closer to the day.

${EVENT_NAME} · ${EVENT_WHERE} · ${EVENT_WHEN}`,
  };
}

function payerTransfer(e: EntrySummary) {
  const ref = reference(e.id);
  const due = formatEuro(Number(e.total_amount));
  return {
    subject: `Your ${EVENT_NAME} entry — payment details inside`,
    html: shell(
      "Registration received",
      `${due} due by bank transfer`,
      `<p style="margin:0;font-size:15px;color:#333">Hello ${esc(e.name)},</p>
       <p style="margin:12px 0 0;font-size:14px;color:#444">
         Thanks for registering. Your entry is held pending payment — please transfer
         <strong>${esc(due)}</strong> to the account below, using
         <strong>${esc(e.name)}</strong> as the payment reference so we can match it to you.
       </p>
       <table style="width:100%;margin:16px 0 0;border-collapse:collapse;background:#f7f9f7;border-radius:8px;font-size:14px">
         <tr><td style="padding:10px 12px;color:#666">Account name</td><td style="padding:10px 12px;text-align:right;font-family:monospace;color:#111">${esc(CLUB_BANK.accountName)}</td></tr>
         <tr><td style="padding:10px 12px;color:#666">IBAN</td><td style="padding:10px 12px;text-align:right;font-family:monospace;color:#111">${esc(CLUB_BANK.iban)}</td></tr>
         <tr><td style="padding:10px 12px;color:#666">BIC</td><td style="padding:10px 12px;text-align:right;font-family:monospace;color:#111">${esc(CLUB_BANK.bic)}</td></tr>
         <tr><td style="padding:10px 12px;color:#666">Reference</td><td style="padding:10px 12px;text-align:right;font-family:monospace;color:#111">${esc(e.name)}</td></tr>
       </table>
       <p style="margin:10px 0 0;font-size:12px;color:#888">Our reference for your entry: ${esc(ref)}</p>
       <h3 style="margin:24px 0 8px;font-size:14px;color:#111">What you're paying for</h3>
       ${orderTableHtml(e)}
       ${rosterHtml(e)}
       ${extrasHtml(e)}
       <p style="margin:24px 0 0;font-size:14px;color:#444">
         Once the transfer lands we'll confirm your place. If you'd rather pay by card,
         reply to this email and we'll send you a link.
       </p>`
    ),
    text: `Hello ${e.name},

Thanks for registering. Your entry is held pending payment.

Please transfer ${due} to:
  Account name: ${CLUB_BANK.accountName}
  IBAN:         ${CLUB_BANK.iban}
  BIC:          ${CLUB_BANK.bic}
  Reference:    ${e.name}

Our reference for your entry: ${ref}

What you're paying for
${orderTableText(e)}
${rosterText(e)}
${e.sponsor_raffle ? `\nRaffle prize offered: ${e.raffle_prize || "no description given"}\n` : ""}
Once the transfer lands we'll confirm your place.

${EVENT_NAME} · ${EVENT_WHERE} · ${EVENT_WHEN}`,
  };
}

function organiserAlert(e: EntrySummary, paid: boolean, amountPaid: number) {
  const ref = reference(e.id);
  const money = paid
    ? `${formatEuro(amountPaid)} paid`
    : `${formatEuro(Number(e.total_amount))} awaiting bank transfer`;

  return {
    subject: `${paid ? "Paid" : "Awaiting transfer"}: ${e.name} — ${money}`,
    html: shell(
      paid ? "New paid entry" : "New entry — awaiting transfer",
      money,
      `<table style="width:100%;border-collapse:collapse;font-size:14px">
         <tr><td style="padding:3px 0;color:#666;width:120px">Name</td><td style="padding:3px 0;color:#111">${esc(e.name)}</td></tr>
         ${e.company_or_club ? `<tr><td style="padding:3px 0;color:#666">Club / company</td><td style="padding:3px 0;color:#111">${esc(e.company_or_club)}</td></tr>` : ""}
         <tr><td style="padding:3px 0;color:#666">Email</td><td style="padding:3px 0"><a href="mailto:${esc(e.email)}" style="color:${GREEN}">${esc(e.email)}</a></td></tr>
         <tr><td style="padding:3px 0;color:#666">Mobile</td><td style="padding:3px 0;color:#111">${esc(e.mobile)}</td></tr>
         ${e.address ? `<tr><td style="padding:3px 0;color:#666">Address</td><td style="padding:3px 0;color:#111">${esc(e.address)}</td></tr>` : ""}
         <tr><td style="padding:3px 0;color:#666">Method</td><td style="padding:3px 0;color:#111">${esc(e.payment_method)}</td></tr>
         <tr><td style="padding:3px 0;color:#666">Reference</td><td style="padding:3px 0;color:#111">${esc(ref)}</td></tr>
       </table>
       <h3 style="margin:24px 0 8px;font-size:14px;color:#111">Order</h3>
       ${orderTableHtml(e)}
       ${rosterHtml(e)}
       ${extrasHtml(e)}
       ${paid ? "" : `<p style="margin:20px 0 0;padding:10px;background:#fff4e0;border-radius:6px;font-size:13px;color:#7a4a00">Nothing has been collected yet — this one needs watching for an incoming transfer referenced <strong>${esc(e.name)}</strong>.</p>`}`
    ),
    text: `${paid ? "New paid entry" : "New entry — awaiting bank transfer"}

Name:    ${e.name}
${e.company_or_club ? `Club:    ${e.company_or_club}\n` : ""}Email:   ${e.email}
Mobile:  ${e.mobile}
${e.address ? `Address: ${e.address}\n` : ""}Method:  ${e.payment_method}
Status:  ${money}
Ref:     ${ref}

Order
${orderTableText(e)}
${rosterText(e)}
${e.sponsor_raffle ? `\nRaffle prize offered: ${e.raffle_prize || "no description given"}\n` : ""}${paid ? "" : `\nNothing collected yet — watch for a transfer referenced "${e.name}".\n`}`,
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Payment confirmed: receipt to the payer, alert to organisers.
 *
 * `notifyOrganisers` exists for the case where an organiser is the one
 * recording the payment — they are sitting in the dashboard having just
 * clicked the button, and do not need to be emailed about their own action.
 */
export async function sendPaidConfirmation(
  entry: EntrySummary,
  amountPaid: number,
  opts: { notifyOrganisers?: boolean } = {}
): Promise<void> {
  const { notifyOrganisers = true } = opts;
  const payer = payerPaid(entry, amountPaid);

  const jobs = [
    send({ to: [entry.email], subject: payer.subject, html: payer.html, text: payer.text }),
  ];

  if (notifyOrganisers) {
    const organiser = organiserAlert(entry, true, amountPaid);
    jobs.push(
      send({
        to: organiserRecipients(),
        subject: organiser.subject,
        html: organiser.html,
        text: organiser.text,
        // Organisers can answer the registrant straight from the alert.
        replyTo: entry.email,
      })
    );
  }

  // Concurrent, and each already swallows its own failures — one bad organiser
  // address must not cost the payer their confirmation.
  await Promise.all(jobs);
}

/** Bank transfer chosen: payment instructions to the payer, alert to organisers. */
export async function sendTransferInstructions(entry: EntrySummary): Promise<void> {
  const payer = payerTransfer(entry);
  const organiser = organiserAlert(entry, false, 0);

  await Promise.all([
    send({ to: [entry.email], subject: payer.subject, html: payer.html, text: payer.text }),
    send({
      to: organiserRecipients(),
      subject: organiser.subject,
      html: organiser.html,
      text: organiser.text,
      replyTo: entry.email,
    }),
  ]);
}
