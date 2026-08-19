"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/app/actions";
import {
  formatEuro,
  PLAYERS_PER_TEAM,
  PRICE_PER_GREEN,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  type Registration,
} from "@/lib/types";

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

// Pinned to the event's timezone rather than the machine's: this component is
// server-rendered and then hydrated, and a UTC server disagreeing with an Irish
// browser about the date would be a hydration mismatch.
const dtFull = new Intl.DateTimeFormat("en-IE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Dublin",
});
const dtShort = new Intl.DateTimeFormat("en-IE", {
  day: "2-digit",
  month: "short",
  timeZone: "Europe/Dublin",
});

const fmtFull = (iso: string | null) => (iso ? dtFull.format(new Date(iso)) : "—");
const fmtShort = (iso: string | null) => (iso ? dtShort.format(new Date(iso)) : "—");

const METHOD_LABEL: Record<string, string> = {
  card: "Card",
  invoice: "Invoice",
  transfer: "Bank transfer",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  pending: "Awaiting payment",
  failed: "Payment failed",
  expired: "Checkout abandoned",
};

/* ------------------------------------------------------------------ *
 * Derived data
 * ------------------------------------------------------------------ */

type StatusFilter = "all" | "paid" | "pending" | "failed" | "expired";
type MethodFilter = "all" | "card" | "invoice" | "transfer";
type SortKey = "newest" | "oldest" | "amount-desc" | "amount-asc" | "name";
type View = "cards" | "table" | "players";

type RosterEntry = {
  reg: Registration;
  team: number;
  name: string;
  handicap: string;
};

function roster(r: Registration): RosterEntry[] {
  const teams = Array.isArray(r.teams) ? r.teams : [];
  const out: RosterEntry[] = [];
  teams.forEach((team, ti) => {
    (team?.players ?? []).forEach((p) => {
      if (p?.name) out.push({ reg: r, team: ti + 1, name: p.name, handicap: p.handicap ?? "" });
    });
  });
  return out;
}

/** Everything the search box should be able to hit, lowercased once per row. */
function haystack(r: Registration): string {
  return [
    r.name,
    r.company_or_club,
    r.email,
    r.mobile,
    r.address,
    r.raffle_prize,
    r.stripe_invoice_number,
    METHOD_LABEL[r.payment_method],
    STATUS_LABEL[r.payment_status],
    ...roster(r).map((p) => p.name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Excel and Sheets execute a cell that begins with =, +, - or @. The raffle
 * prize box, the name and the company field are free text typed by the public,
 * so an export opened on an organiser's laptop is a code path that starts at a
 * stranger's keyboard. A leading apostrophe makes the cell inert while still
 * displaying the original text. Genuine numbers are exempt so amounts stay
 * numeric in the spreadsheet.
 */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(filename: string, body: string) {
  // Leading BOM so Excel opens the file as UTF-8 and doesn't mangle the € sign.
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function registrationsCsv(rows: Registration[]): string {
  const head = [
    "Registered",
    "Name",
    "Company or club",
    "Email",
    "Mobile",
    "Address",
    "Teams",
    "Players named",
    "Tee boxes",
    "Greens",
    "Donation",
    "Raffle prize",
    "Total",
    "Method",
    "Status",
    "Amount paid",
    "Paid at",
    "Invoice number",
    "Invoice URL",
  ];
  const body = rows.map((r) =>
    [
      fmtFull(r.created_at),
      r.name,
      r.company_or_club ?? "",
      r.email,
      r.mobile,
      r.address ?? "",
      r.number_of_teams,
      roster(r).length,
      r.tee_box_count,
      r.green_count,
      Number(r.donation_amount) || 0,
      r.sponsor_raffle ? r.raffle_prize || "Yes (unspecified)" : "",
      Number(r.total_amount) || 0,
      METHOD_LABEL[r.payment_method] ?? r.payment_method,
      STATUS_LABEL[r.payment_status] ?? r.payment_status,
      Number(r.amount_paid) || 0,
      fmtFull(r.paid_at),
      r.stripe_invoice_number ?? "",
      r.stripe_invoice_url ?? "",
    ]
      .map(csvCell)
      .join(",")
  );
  return [head.join(","), ...body].join("\n");
}

function playersCsv(rows: RosterEntry[]): string {
  const head = [
    "Player",
    "Handicap",
    "Team",
    "Registered by",
    "Company or club",
    "Email",
    "Mobile",
    "Payment",
  ];
  const body = rows.map((p) =>
    [
      p.name,
      p.handicap,
      `Team ${p.team}`,
      p.reg.name,
      p.reg.company_or_club ?? "",
      p.reg.email,
      p.reg.mobile,
      STATUS_LABEL[p.reg.payment_status] ?? p.reg.payment_status,
    ]
      .map(csvCell)
      .join(",")
  );
  return [head.join(","), ...body].join("\n");
}

/* ------------------------------------------------------------------ *
 * Small shared UI
 * ------------------------------------------------------------------ */

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
        } catch {
          // Clipboard blocked (insecure origin, permissions) — leave the label be.
        }
      }}
      className="rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-400 transition hover:bg-gray-100 hover:text-gray-800"
      title={`Copy ${text}`}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

function StatusBadge({ r, compact = false }: { r: Registration; compact?: boolean }) {
  const method = METHOD_LABEL[r.payment_method] ?? r.payment_method;
  const tone =
    r.payment_status === "paid"
      ? "bg-green-100 text-green-800 ring-green-200"
      : r.payment_status === "failed"
        ? "bg-red-100 text-red-800 ring-red-200"
        : r.payment_status === "expired"
          ? "bg-gray-100 text-gray-600 ring-gray-200"
          : "bg-amber-100 text-amber-800 ring-amber-200";
  const dot =
    r.payment_status === "paid"
      ? "bg-green-600"
      : r.payment_status === "failed"
        ? "bg-red-600"
        : r.payment_status === "expired"
          ? "bg-gray-400"
          : "bg-amber-500";

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${tone}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {compact
        ? (STATUS_LABEL[r.payment_status] ?? r.payment_status)
        : `${STATUS_LABEL[r.payment_status] ?? r.payment_status} · ${method}`}
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-4 shadow-sm ring-1 ${
        accent ? "bg-gaa-green-dark ring-black/10" : "bg-white ring-black/5"
      }`}
    >
      <p
        className={`text-xs font-medium uppercase tracking-wide ${
          accent ? "text-white/70" : "text-gray-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${
          accent ? "text-white" : "text-gaa-green-dark"
        }`}
      >
        {value}
      </p>
      {hint && (
        <p className={`mt-0.5 text-xs ${accent ? "text-white/70" : "text-gray-400"}`}>{hint}</p>
      )}
    </div>
  );
}

/** Line-by-line breakdown of what the total is made of. */
function Breakdown({ r }: { r: Registration }) {
  const lines: Array<[string, number]> = [];
  if (r.number_of_teams > 0) {
    lines.push([
      `${r.number_of_teams} × team @ ${formatEuro(PRICE_PER_TEAM)}`,
      r.number_of_teams * PRICE_PER_TEAM,
    ]);
  }
  if (r.tee_box_count > 0) {
    lines.push([
      `${r.tee_box_count} × tee box @ ${formatEuro(PRICE_PER_TEE_BOX)}`,
      r.tee_box_count * PRICE_PER_TEE_BOX,
    ]);
  }
  if (r.green_count > 0) {
    lines.push([
      `${r.green_count} × green @ ${formatEuro(PRICE_PER_GREEN)}`,
      r.green_count * PRICE_PER_GREEN,
    ]);
  }
  if (Number(r.donation_amount) > 0) {
    lines.push(["Donation", Number(r.donation_amount)]);
  }

  if (lines.length === 0) {
    return <p className="text-sm text-gray-500">Nothing chargeable — raffle prize only.</p>;
  }

  return (
    <dl className="space-y-1 text-sm">
      {lines.map(([label, amount]) => (
        <div key={label} className="flex justify-between gap-4">
          <dt className="text-gray-600">{label}</dt>
          <dd className="tabular-nums text-gray-800">{formatEuro(amount)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-4 border-t border-gray-200 pt-1 font-semibold">
        <dt className="text-gray-700">Total</dt>
        <dd className="tabular-nums text-gaa-green-dark">{formatEuro(Number(r.total_amount))}</dd>
      </div>
    </dl>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="font-medium text-gray-500">{label}</span>
      <span className="min-w-0 break-words text-gray-800">{children}</span>
    </div>
  );
}

/** Everything about one registration — shared by the card and table views. */
function Details({ r }: { r: Registration }) {
  const teams = Array.isArray(r.teams) ? r.teams : [];
  const named = roster(r);
  const places = r.number_of_teams * PLAYERS_PER_TEAM;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4">
        <section>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Contact</h4>
          <div className="space-y-1.5">
            <Field label="Email">
              <a href={`mailto:${r.email}`} className="text-gaa-green hover:underline">
                {r.email}
              </a>
              <CopyButton text={r.email} />
            </Field>
            <Field label="Mobile">
              <a href={`tel:${r.mobile.replace(/\s+/g, "")}`} className="text-gaa-green hover:underline">
                {r.mobile}
              </a>
              <CopyButton text={r.mobile} />
            </Field>
            {r.company_or_club && <Field label="Company / club">{r.company_or_club}</Field>}
            <Field label="Address">
              {r.address || <span className="text-gray-400">Not given</span>}
            </Field>
            <Field label="Registered">{fmtFull(r.created_at)}</Field>
          </div>
        </section>

        {r.sponsor_raffle && (
          <section className="rounded-lg bg-gaa-gold/15 p-3 ring-1 ring-gaa-gold/40">
            <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-gaa-green-dark">
              Raffle prize
            </h4>
            <p className="text-sm text-gray-800">
              {r.raffle_prize || "Offered, no description given."}
            </p>
          </section>
        )}
      </div>

      <div className="space-y-4">
        <section>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Order</h4>
          <Breakdown r={r} />
        </section>

        <section>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Payment</h4>
          <div className="space-y-1.5">
            <Field label="Method">{METHOD_LABEL[r.payment_method] ?? r.payment_method}</Field>
            <Field label="Status">{STATUS_LABEL[r.payment_status] ?? r.payment_status}</Field>
            <Field label="Amount paid">
              <span className="tabular-nums">{formatEuro(Number(r.amount_paid))}</span>
              {Number(r.amount_paid) > 0 && Number(r.amount_paid) < Number(r.total_amount) && (
                <span className="ml-1 text-amber-700">
                  ({formatEuro(Number(r.total_amount) - Number(r.amount_paid))} short)
                </span>
              )}
            </Field>
            {r.paid_at && <Field label="Paid at">{fmtFull(r.paid_at)}</Field>}
            {r.stripe_invoice_url && (
              <Field label="Invoice">
                <a
                  href={r.stripe_invoice_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-gaa-green hover:underline"
                >
                  {r.stripe_invoice_number ?? "Open in Stripe"} ↗
                </a>
              </Field>
            )}
            {(r.stripe_customer_id ||
              r.stripe_payment_intent_id ||
              r.stripe_checkout_session_id ||
              r.stripe_invoice_id) && (
              <details className="pt-1">
                <summary className="cursor-pointer text-xs font-medium text-gray-500 hover:text-gray-800">
                  Stripe references
                </summary>
                <div className="mt-1 space-y-1">
                  {(
                    [
                      ["Customer", r.stripe_customer_id],
                      ["Payment intent", r.stripe_payment_intent_id],
                      ["Checkout session", r.stripe_checkout_session_id],
                      ["Invoice ID", r.stripe_invoice_id],
                    ] as Array<[string, string | null]>
                  )
                    .filter(([, v]) => Boolean(v))
                    .map(([label, v]) => (
                      <div key={label} className="flex items-center gap-1 text-xs">
                        <span className="shrink-0 text-gray-500">{label}</span>
                        <code className="truncate font-mono text-gray-700">{v}</code>
                        <CopyButton text={String(v)} />
                      </div>
                    ))}
                </div>
              </details>
            )}
          </div>
        </section>
      </div>

      <section>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">
          Players{" "}
          <span className="font-medium normal-case tracking-normal text-gray-400">
            ({named.length} named{places > 0 ? ` of ${places}` : ""})
          </span>
        </h4>
        {named.length === 0 ? (
          <p className="text-sm text-gray-500">No player names supplied yet.</p>
        ) : (
          <div className="space-y-2">
            {teams.map((team, ti) => {
              const players = (team?.players ?? []).filter((p) => p?.name);
              if (players.length === 0) return null;
              return (
                <div key={ti} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-wide text-gaa-green-dark">
                      Team {ti + 1}
                    </p>
                    <span className="text-xs text-gray-400">
                      {players.length}/{PLAYERS_PER_TEAM}
                    </span>
                  </div>
                  <ol className="space-y-1 text-sm">
                    {players.map((p, pi) => (
                      <li key={pi} className="flex justify-between gap-2">
                        <span className="text-gray-800">{p.name}</span>
                        <span className="shrink-0 tabular-nums text-gray-400">
                          {p.handicap ? `h/c ${p.handicap}` : "—"}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function RegistrationCard({
  r,
  open,
  onToggle,
}: {
  r: Registration;
  open: boolean;
  onToggle: () => void;
}) {
  const named = roster(r).length;
  const summary = [
    r.number_of_teams > 0 && `${r.number_of_teams} team${r.number_of_teams === 1 ? "" : "s"}`,
    r.tee_box_count > 0 && `${r.tee_box_count} tee box`,
    r.green_count > 0 && `${r.green_count} green`,
    Number(r.donation_amount) > 0 && `${formatEuro(Number(r.donation_amount))} donation`,
    r.sponsor_raffle && "raffle prize",
    r.number_of_teams > 0 && `${named}/${r.number_of_teams * PLAYERS_PER_TEAM} players named`,
  ].filter(Boolean) as string[];

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-start justify-between gap-3 px-5 py-4 text-left transition hover:bg-gray-50"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden
            >
              ▶
            </span>
            <p className="truncate text-lg font-semibold text-gaa-green-dark">{r.name}</p>
          </div>
          <p className="mt-0.5 pl-5 text-sm text-gray-500">
            {r.company_or_club ? `${r.company_or_club} · ` : ""}
            {r.email}
          </p>
          {summary.length > 0 && (
            <p className="mt-1 pl-5 text-xs text-gray-500">{summary.join(" · ")}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold tabular-nums text-gaa-green">
            {formatEuro(Number(r.total_amount))}
          </p>
          <div className="mt-1 flex justify-end">
            <StatusBadge r={r} />
          </div>
          <p className="mt-1 text-xs text-gray-400">{fmtFull(r.created_at)}</p>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 bg-gray-50/40 px-5 py-4">
          <Details r={r} />
        </div>
      )}
    </div>
  );
}

function TableView({
  rows,
  expanded,
  onToggle,
}: {
  rows: Registration[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-black/5">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th scope="col" className="w-8 px-3 py-2.5">
              <span className="sr-only">Expand</span>
            </th>
            <th scope="col" className="px-3 py-2.5">Date</th>
            <th scope="col" className="px-3 py-2.5">Name</th>
            <th scope="col" className="px-3 py-2.5">Contact</th>
            <th scope="col" className="px-3 py-2.5 text-right">Teams</th>
            <th scope="col" className="px-3 py-2.5">Extras</th>
            <th scope="col" className="px-3 py-2.5 text-right">Total</th>
            <th scope="col" className="px-3 py-2.5">Payment</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const open = expanded.has(r.id);
            const extras = [
              r.tee_box_count > 0 && `${r.tee_box_count} tee`,
              r.green_count > 0 && `${r.green_count} green`,
              Number(r.donation_amount) > 0 && formatEuro(Number(r.donation_amount)),
              r.sponsor_raffle && "raffle",
            ].filter(Boolean) as string[];

            return (
              <Fragment key={r.id}>
                <tr
                  onClick={() => onToggle(r.id)}
                  className="cursor-pointer align-top transition hover:bg-gray-50"
                >
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={open ? `Hide details for ${r.name}` : `Show details for ${r.name}`}
                      className={`text-xs text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(r.id);
                      }}
                    >
                      ▶
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-500">
                    {fmtShort(r.created_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-gaa-green-dark">{r.name}</p>
                    {r.company_or_club && (
                      <p className="text-xs text-gray-500">{r.company_or_club}</p>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <a
                      href={`mailto:${r.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-gaa-green hover:underline"
                    >
                      {r.email}
                    </a>
                    <p className="text-xs text-gray-500">{r.mobile}</p>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-800">
                    {r.number_of_teams || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-600">
                    {extras.length > 0 ? extras.join(" · ") : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-gaa-green-dark">
                    {formatEuro(Number(r.total_amount))}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge r={r} />
                  </td>
                </tr>
                {open && (
                  <tr className="bg-gray-50/60">
                    <td colSpan={8} className="px-5 py-4">
                      <Details r={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PlayersView({
  players,
  searching,
}: {
  players: RosterEntry[];
  searching: boolean;
}) {
  if (players.length === 0) {
    return (
      <div className="rounded-xl bg-white p-10 text-center text-gray-500 shadow-sm ring-1 ring-black/5">
        {searching
          ? "No player names match your search."
          : "No player names have been entered yet."}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-black/5">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th scope="col" className="w-10 px-3 py-2.5 text-right">#</th>
            <th scope="col" className="px-3 py-2.5">Player</th>
            <th scope="col" className="px-3 py-2.5">Handicap</th>
            <th scope="col" className="px-3 py-2.5">Team</th>
            <th scope="col" className="px-3 py-2.5">Registered by</th>
            <th scope="col" className="px-3 py-2.5">Payment</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {players.map((p, i) => (
            <tr key={`${p.reg.id}-${p.team}-${i}`} className="transition hover:bg-gray-50">
              <td className="px-3 py-2 text-right tabular-nums text-gray-400">{i + 1}</td>
              <td className="px-3 py-2 font-medium text-gray-900">{p.name}</td>
              <td className="px-3 py-2 tabular-nums text-gray-600">{p.handicap || "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                {p.reg.company_or_club ? `${p.reg.company_or_club} — ` : ""}Team {p.team}
              </td>
              <td className="px-3 py-2">
                <span className="text-gray-800">{p.reg.name}</span>
                <a
                  href={`mailto:${p.reg.email}`}
                  className="block text-xs text-gaa-green hover:underline"
                >
                  {p.reg.email}
                </a>
              </td>
              <td className="px-3 py-2">
                <StatusBadge r={p.reg} compact />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export default function Dashboard({ registrations }: { registrations: Registration[] }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [method, setMethod] = useState<MethodFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [view, setView] = useState<View>("cards");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to search, Escape clears it — this page gets used one-handed while
  // someone reads their details down the phone.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && target === searchRef.current) {
        setQuery("");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const indexed = useMemo(
    () => registrations.map((r) => ({ r, hay: haystack(r) })),
    [registrations]
  );

  const q = query.trim().toLowerCase();

  // Filtered by everything *except* status, so the status pills can show what
  // switching to each one would actually give you.
  const preStatus = useMemo(
    () =>
      indexed
        .filter(({ r }) => method === "all" || r.payment_method === method)
        .filter(({ hay }) => !q || hay.includes(q))
        .map(({ r }) => r),
    [indexed, method, q]
  );

  const counts = useMemo(
    () => ({
      all: preStatus.length,
      paid: preStatus.filter((r) => r.payment_status === "paid").length,
      pending: preStatus.filter((r) => r.payment_status === "pending").length,
      failed: preStatus.filter((r) => r.payment_status === "failed").length,
      expired: preStatus.filter((r) => r.payment_status === "expired").length,
    }),
    [preStatus]
  );

  const filtered = useMemo(() => {
    const rows = preStatus.filter((r) => status === "all" || r.payment_status === status);
    return [...rows].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return a.created_at.localeCompare(b.created_at);
        case "amount-desc":
          return Number(b.total_amount) - Number(a.total_amount);
        case "amount-asc":
          return Number(a.total_amount) - Number(b.total_amount);
        case "name":
          return a.name.localeCompare(b.name, "en-IE");
        default:
          return b.created_at.localeCompare(a.created_at);
      }
    });
  }, [preStatus, status, sort]);

  const players = useMemo(() => {
    const all = filtered.flatMap(roster);
    // In the players view the search should narrow to the matching players, not
    // list every team-mate of whoever matched.
    return q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all;
  }, [filtered, q]);

  // Totals follow the filters: filter to "awaiting" and the outstanding figure
  // is what the chase-up list is worth, not what the whole event is worth.
  const stats = useMemo(() => {
    const teams = filtered.reduce((s, r) => s + (r.number_of_teams || 0), 0);
    const pledged = filtered.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const collected = filtered
      .filter((r) => r.payment_status === "paid")
      .reduce((s, r) => s + Number(r.amount_paid || 0), 0);
    // Abandoned checkouts are nobody's debt — counting them would inflate the
    // figure the organisers treat as their chase-up list.
    const outstanding = filtered
      .filter((r) => r.payment_status !== "paid" && r.payment_status !== "expired")
      .reduce((s, r) => s + Number(r.total_amount || 0), 0);
    return {
      teams,
      pledged,
      collected,
      outstanding,
      namedPlayers: filtered.reduce((s, r) => s + roster(r).length, 0),
      raffle: filtered.filter((r) => r.sponsor_raffle).length,
      pct: pledged > 0 ? Math.min(100, Math.round((collected / pledged) * 100)) : 0,
    };
  }, [filtered]);

  const filtersActive = q !== "" || status !== "all" || method !== "all";

  function resetFilters() {
    setQuery("");
    setStatus("all");
    setMethod("all");
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyEmails() {
    const emails = Array.from(new Set(filtered.map((r) => r.email))).join(", ");
    try {
      await navigator.clipboard.writeText(emails);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Nothing useful to say if the browser refuses clipboard access.
    }
  }

  const selectClass =
    "rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 shadow-sm outline-none transition focus:border-gaa-green focus:ring-2 focus:ring-gaa-green/30";
  const toolClass =
    "rounded-lg px-2.5 py-1 text-sm font-medium text-gray-600 transition hover:bg-gray-100";

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-16">
      <header className="sticky top-0 z-20 -mx-4 mb-6 border-b border-black/5 bg-[var(--background)]/90 px-4 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="inline-block rounded-full bg-gaa-gold px-3 py-1 text-xs font-bold uppercase tracking-wide text-gaa-green-dark">
              Longford GAA
            </p>
            <h1 className="mt-2 text-2xl font-bold text-gaa-green-dark">
              Golf Classic 2026 — Registrations
            </h1>
            <p className="text-sm text-gray-500">
              {registrations.length} registration{registrations.length === 1 ? "" : "s"} in total
              {filtersActive && ` · showing ${filtered.length}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => startRefresh(() => router.refresh())}
              disabled={refreshing}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-60"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <form action={logout}>
              <button className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Registrations"
          value={String(filtered.length)}
          hint={filtersActive ? `of ${registrations.length}` : undefined}
        />
        <StatCard
          label="Teams"
          value={String(stats.teams)}
          hint={`${stats.teams * PLAYERS_PER_TEAM} places`}
        />
        <StatCard
          label="Players named"
          value={String(stats.namedPlayers)}
          hint={
            stats.teams > 0
              ? `${stats.teams * PLAYERS_PER_TEAM - stats.namedPlayers} still to confirm`
              : undefined
          }
        />
        <StatCard label="Raffle prizes" value={String(stats.raffle)} />
        <StatCard
          label="Collected"
          value={formatEuro(stats.collected)}
          hint={`${stats.pct}% of pledged`}
          accent
        />
        <StatCard
          label="Outstanding"
          value={formatEuro(stats.outstanding)}
          hint={`${counts.pending + counts.failed} unpaid`}
        />
      </div>

      <div className="mb-6">
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full bg-gaa-green transition-all"
            style={{ width: `${stats.pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-gray-500">
          {formatEuro(stats.collected)} confirmed by Stripe of {formatEuro(stats.pledged)} pledged.
          Only payments Stripe has confirmed count as collected.
        </p>
      </div>

      <div className="mb-4 space-y-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[16rem] flex-1">
            <label htmlFor="admin-search" className="sr-only">
              Search registrations
            </label>
            <input
              id="admin-search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, club, email, phone, player…"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-16 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gaa-green focus:ring-2 focus:ring-gaa-green/30"
            />
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              aria-hidden
            >
              ⌕
            </span>
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
              >
                Clear
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-400 sm:block">
                /
              </kbd>
            )}
          </div>

          <select
            aria-label="Filter by payment method"
            value={method}
            onChange={(e) => setMethod(e.target.value as MethodFilter)}
            className={selectClass}
          >
            <option value="all">All methods</option>
            <option value="card">Card</option>
            <option value="invoice">Invoice</option>
            <option value="transfer">Bank transfer</option>
          </select>

          <select
            aria-label="Sort registrations"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className={selectClass}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="amount-desc">Amount: high to low</option>
            <option value="amount-asc">Amount: low to high</option>
            <option value="name">Name A–Z</option>
          </select>

          <div className="flex rounded-lg border border-gray-300 bg-gray-50 p-0.5 shadow-sm">
            {(["cards", "table", "players"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition ${
                  view === v
                    ? "bg-white text-gaa-green-dark shadow-sm"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["all", "All"],
              ["paid", "Paid"],
              ["pending", "Awaiting"],
              ["failed", "Failed"],
              ["expired", "Abandoned"],
            ] as Array<[StatusFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatus(key)}
              aria-pressed={status === key}
              className={`rounded-full px-3 py-1 text-sm font-medium ring-1 transition ${
                status === key
                  ? "bg-gaa-green-dark text-white ring-gaa-green-dark"
                  : "bg-white text-gray-600 ring-gray-300 hover:bg-gray-50"
              }`}
            >
              {label}
              <span
                className={`ml-1.5 tabular-nums ${
                  status === key ? "text-white/70" : "text-gray-400"
                }`}
              >
                {counts[key]}
              </span>
            </button>
          ))}

          <span className="mx-1 hidden h-5 w-px bg-gray-200 sm:block" aria-hidden />

          {view !== "players" && (
            <>
              <button
                type="button"
                onClick={() => setExpanded(new Set(filtered.map((r) => r.id)))}
                className={toolClass}
              >
                Expand all
              </button>
              <button type="button" onClick={() => setExpanded(new Set())} className={toolClass}>
                Collapse all
              </button>
            </>
          )}

          <button type="button" onClick={copyEmails} className={toolClass}>
            {copied ? "Emails copied ✓" : "Copy emails"}
          </button>

          <button
            type="button"
            onClick={() =>
              view === "players"
                ? download(`golf-classic-players-${stamp()}.csv`, playersCsv(players))
                : download(`golf-classic-registrations-${stamp()}.csv`, registrationsCsv(filtered))
            }
            className={toolClass}
          >
            Export CSV
          </button>

          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="ml-auto rounded-lg px-2.5 py-1 text-sm font-medium text-gaa-green transition hover:bg-gaa-green/10"
            >
              Reset filters
            </button>
          )}
        </div>
      </div>

      {registrations.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center text-gray-500 shadow-sm ring-1 ring-black/5">
          No registrations yet. They will appear here as soon as the first entry comes in.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center shadow-sm ring-1 ring-black/5">
          <p className="font-medium text-gray-700">Nothing matches these filters.</p>
          <button
            type="button"
            onClick={resetFilters}
            className="mt-2 text-sm font-medium text-gaa-green hover:underline"
          >
            Reset filters
          </button>
        </div>
      ) : view === "players" ? (
        <>
          <p className="mb-2 text-sm text-gray-500">
            {players.length} player{players.length === 1 ? "" : "s"} named across {filtered.length}{" "}
            registration{filtered.length === 1 ? "" : "s"}.
          </p>
          <PlayersView players={players} searching={q !== ""} />
        </>
      ) : view === "table" ? (
        <TableView rows={filtered} expanded={expanded} onToggle={toggle} />
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <RegistrationCard
              key={r.id}
              r={r}
              open={expanded.has(r.id)}
              onToggle={() => toggle(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
