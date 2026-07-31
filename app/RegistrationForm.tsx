"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { submitRegistration, type SubmitState } from "./actions";
import {
  MAX_TEAMS,
  PLAYERS_PER_TEAM,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  PRICE_PER_GREEN,
  MAX_TEE_BOXES,
  MAX_GREENS,
  MAX_DONATION,
  REGISTRATION_DRAFT_KEY,
  calculateTotal,
  formatEuro,
  type PaymentMethod,
} from "@/lib/types";

/**
 * Where the half-filled form lives while the payer is off at Stripe.
 *
 * sessionStorage, not localStorage: this holds names, emails and phone
 * numbers, and it should not outlive the tab — particularly on a shared
 * clubhouse computer.
 */
const DRAFT_KEY = REGISTRATION_DRAFT_KEY;

/** Inputs React owns; restored from state, not by writing to the DOM. */
const CONTROLLED_FIELDS = new Set([
  "number_of_teams",
  "tee_box_count",
  "green_count",
  "donation_amount",
  "sponsor_raffle",
  "payment_method",
]);

type Draft = {
  numTeams: number;
  teeBox: number;
  green: number;
  donation: number;
  sponsorRaffle: boolean;
  payMethod: PaymentMethod;
  fields: Record<string, string>;
};

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm outline-none transition focus:border-gaa-green focus:ring-2 focus:ring-gaa-green/30";
const labelClass = "block text-sm font-medium text-gray-800 mb-1";

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {label}
        </p>
        <p className="truncate font-mono text-sm text-gray-900">{value}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md bg-gaa-green px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-gaa-green-dark"
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

const SUBMIT_LABEL: Record<PaymentMethod, string> = {
  card: "Continue to secure payment",
  invoice: "Submit & email me an invoice",
  transfer: "Submit registration",
};

function SubmitButton({ method }: { method: PaymentMethod }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gaa-green px-6 py-3 text-base font-semibold text-white shadow-md transition hover:bg-gaa-green-dark disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Submitting…" : SUBMIT_LABEL[method]}
    </button>
  );
}

function PaymentOption({
  value,
  selected,
  onSelect,
  title,
  blurb,
  icon,
}: {
  value: PaymentMethod;
  selected: PaymentMethod;
  onSelect: (m: PaymentMethod) => void;
  title: string;
  blurb: string;
  icon: string;
}) {
  const isSelected = selected === value;
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition ${
        isSelected
          ? "border-gaa-green bg-gaa-green/5 ring-2 ring-gaa-green/30"
          : "border-gray-200 bg-white hover:border-gaa-green/40"
      }`}
    >
      <input
        type="radio"
        name="payment_method"
        value={value}
        checked={isSelected}
        onChange={() => onSelect(value)}
        className="mt-1 h-4 w-4 shrink-0 text-gaa-green focus:ring-gaa-green"
      />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-gray-900">
          {icon} {title}
        </span>
        <span className="mt-0.5 block text-xs text-gray-500">{blurb}</span>
      </span>
    </label>
  );
}

export default function RegistrationForm() {
  const initial: SubmitState = { ok: false };
  const [state, formAction] = useActionState(submitRegistration, initial);

  const [numTeams, setNumTeams] = useState(1);
  const [teeBox, setTeeBox] = useState(0);
  const [green, setGreen] = useState(0);
  const [donation, setDonation] = useState(0);
  const [sponsorRaffle, setSponsorRaffle] = useState(false);
  const [payMethod, setPayMethod] = useState<PaymentMethod>("card");

  const formRef = useRef<HTMLFormElement>(null);
  // Text values waiting to be written back once the matching inputs exist.
  const pendingFields = useRef<Record<string, string> | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  // Restore the controlled values first — numTeams decides how many player
  // blocks get rendered, and those inputs have to exist before we can fill them.
  //
  /* eslint-disable react-hooks/set-state-in-effect --
     sessionStorage has no server-side equivalent, so seeding these through
     useState initialisers would make the client's first render disagree with
     the server HTML. Restoring after hydration is the intended way to sync
     with an external browser store. */
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw) as Draft;
        if (draft.numTeams) setNumTeams(draft.numTeams);
        if (draft.teeBox) setTeeBox(draft.teeBox);
        if (draft.green) setGreen(draft.green);
        if (draft.donation) setDonation(draft.donation);
        if (draft.sponsorRaffle) setSponsorRaffle(true);
        if (draft.payMethod) setPayMethod(draft.payMethod);
        pendingFields.current = draft.fields ?? null;
      }
    } catch {
      sessionStorage.removeItem(DRAFT_KEY);
    }
    setDraftLoaded(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Second pass: the player rows are on the page now, so put the text back.
  useEffect(() => {
    if (!draftLoaded || !pendingFields.current || !formRef.current) return;
    for (const [name, value] of Object.entries(pendingFields.current)) {
      if (CONTROLLED_FIELDS.has(name)) continue;
      const field = formRef.current.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.value = value;
      }
    }
    pendingFields.current = null;
  }, [draftLoaded, numTeams, sponsorRaffle]);

  // Once the entry is in, the draft has served its purpose. Leaving it would
  // pre-fill the form with someone else's details for the next person.
  useEffect(() => {
    if (state.ok) sessionStorage.removeItem(DRAFT_KEY);
  }, [state.ok]);

  const saveDraft = useCallback(() => {
    if (!formRef.current) return;
    const fields: Record<string, string> = {};
    for (const [key, value] of new FormData(formRef.current).entries()) {
      if (typeof value === "string") fields[key] = value;
    }
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          numTeams, teeBox, green, donation, sponsorRaffle, payMethod, fields,
        } satisfies Draft)
      );
    } catch {
      // Private browsing or a full quota — losing the draft is not worth
      // breaking the form over.
    }
  }, [numTeams, teeBox, green, donation, sponsorRaffle, payMethod]);

  // The state above changes a tick after the input event that caused it, so
  // re-save whenever it settles rather than only on change.
  useEffect(() => {
    if (draftLoaded) saveDraft();
  }, [draftLoaded, saveDraft]);

  const total = useMemo(
    () =>
      calculateTotal({
        number_of_teams: numTeams,
        tee_box_count: teeBox,
        green_count: green,
        donation_amount: donation,
      }),
    [numTeams, teeBox, green, donation]
  );

  // The card path never reaches here — that submit redirects to Stripe.
  if (state.ok) {
    return (
      <Confirmation method={state.method ?? "transfer"} invoiceUrl={state.invoiceUrl} />
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onChange={saveDraft}
      className="space-y-8"
    >
      {/* Your details */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-4 text-lg font-bold text-gaa-green-dark">Your details</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="name">
              Name <span className="text-red-500">*</span>
            </label>
            <input id="name" name="name" required className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="company_or_club">
              Company or club
            </label>
            <input id="company_or_club" name="company_or_club" className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="address">
              Address
            </label>
            <input id="address" name="address" className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="mobile">
              Mobile <span className="text-red-500">*</span>
            </label>
            <input
              id="mobile"
              name="mobile"
              type="tel"
              required
              placeholder="(000) 000-0000"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="email">
              Email <span className="text-red-500">*</span>
            </label>
            <input id="email" name="email" type="email" required className={inputClass} />
          </div>
        </div>
      </section>

      {/* Entry & sponsorship */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-1 text-lg font-bold text-gaa-green-dark">
          Entry &amp; sponsorship
        </h2>
        <p className="mb-4 text-sm text-gray-500">
          Team of 4 — {formatEuro(PRICE_PER_TEAM)} / team
        </p>
        <div className="max-w-xs">
          <label className={labelClass} htmlFor="number_of_teams">
            Number of teams <span className="text-red-500">*</span>
          </label>
          <select
            id="number_of_teams"
            name="number_of_teams"
            required
            value={numTeams}
            onChange={(e) => setNumTeams(Number(e.target.value))}
            className={inputClass}
          >
            {Array.from({ length: MAX_TEAMS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} team{n > 1 ? "s" : ""} — {formatEuro(n * PRICE_PER_TEAM)}
              </option>
            ))}
          </select>
        </div>

        {/* Team player details */}
        <div className="mt-6 space-y-6">
          {Array.from({ length: numTeams }, (_, i) => i + 1).map((t) => (
            <div key={t} className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
              <h3 className="mb-3 flex items-center gap-2 font-semibold text-gaa-green-dark">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gaa-gold text-xs font-bold text-gaa-green-dark">
                  {t}
                </span>
                Team {t}
              </h3>
              <div className="space-y-3">
                {Array.from({ length: PLAYERS_PER_TEAM }, (_, j) => j + 1).map((p) => (
                  <div key={p} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <label
                        className="mb-1 block text-xs font-medium text-gray-600"
                        htmlFor={`team_${t}_player_${p}_name`}
                      >
                        Player {p} name
                        {t === 1 && p === 1 && <span className="text-red-500"> *</span>}
                      </label>
                      <input
                        id={`team_${t}_player_${p}_name`}
                        name={`team_${t}_player_${p}_name`}
                        className={inputClass}
                        required={t === 1 && p === 1}
                      />
                    </div>
                    <div>
                      <label
                        className="mb-1 block text-xs font-medium text-gray-600"
                        htmlFor={`team_${t}_player_${p}_handicap`}
                      >
                        Handicap
                      </label>
                      <input
                        id={`team_${t}_player_${p}_handicap`}
                        name={`team_${t}_player_${p}_handicap`}
                        className={inputClass}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Additional sponsorship / donation */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-4 text-lg font-bold text-gaa-green-dark">
          Additional sponsorship &amp; donation
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={labelClass} htmlFor="tee_box_count">
              Tee box sponsorship
            </label>
            <select
              id="tee_box_count"
              name="tee_box_count"
              value={teeBox}
              onChange={(e) => setTeeBox(Number(e.target.value))}
              className={inputClass}
            >
              <option value={0}>None</option>
              {Array.from({ length: MAX_TEE_BOXES }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} × {formatEuro(PRICE_PER_TEE_BOX)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="green_count">
              Green sponsorship
            </label>
            <select
              id="green_count"
              name="green_count"
              value={green}
              onChange={(e) => setGreen(Number(e.target.value))}
              className={inputClass}
            >
              <option value={0}>None</option>
              {Array.from({ length: MAX_GREENS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} × {formatEuro(PRICE_PER_GREEN)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="donation_amount">
              Donation amount (€)
            </label>
            <input
              id="donation_amount"
              name="donation_amount"
              type="number"
              min={0}
              max={MAX_DONATION}
              step="0.01"
              value={donation || ""}
              onChange={(e) =>
                setDonation(Math.min(Number(e.target.value) || 0, MAX_DONATION))
              }
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="flex items-center gap-3 text-sm font-medium text-gray-800">
            <input
              type="checkbox"
              name="sponsor_raffle"
              checked={sponsorRaffle}
              onChange={(e) => setSponsorRaffle(e.target.checked)}
              className="h-5 w-5 rounded border-gray-300 text-gaa-green focus:ring-gaa-green"
            />
            Yes, I&apos;d like to sponsor a raffle prize
          </label>
          {sponsorRaffle && (
            <div className="mt-3">
              <label className={labelClass} htmlFor="raffle_prize">
                Raffle prize — what would you like to donate?
              </label>
              <textarea
                id="raffle_prize"
                name="raffle_prize"
                rows={3}
                className={inputClass}
              />
            </div>
          )}
        </div>
      </section>

      {/* Total */}
      <section className="rounded-2xl bg-gaa-green-dark p-6 text-white shadow-md">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium uppercase tracking-wide text-white/80">
            Total amount due
          </span>
          <span className="text-3xl font-bold text-gaa-gold">
            {formatEuro(total)}
          </span>
        </div>
      </section>

      {/* Payment */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-4 text-lg font-bold text-gaa-green-dark">
          How would you like to pay?
        </h2>
        <div className="space-y-3">
          <PaymentOption
            value="card"
            selected={payMethod}
            onSelect={setPayMethod}
            icon="💳"
            title="Pay now by card"
            blurb="Secure Stripe checkout. Instant confirmation and an emailed receipt."
          />
          <PaymentOption
            value="invoice"
            selected={payMethod}
            onSelect={setPayMethod}
            icon="🧾"
            title="Send me an invoice"
            blurb="We'll email a formal invoice, payable within 30 days by card or bank transfer. Best if a company is sponsoring."
          />
          <PaymentOption
            value="transfer"
            selected={payMethod}
            onSelect={setPayMethod}
            icon="🏦"
            title="Bank transfer"
            blurb="We'll show you the club's account details to pay manually."
          />
        </div>
      </section>

      {state.error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-700 ring-1 ring-red-200">
          {state.error}
        </p>
      )}

      <SubmitButton method={payMethod} />
    </form>
  );
}

function Confirmation({
  method,
  invoiceUrl,
}: {
  method: PaymentMethod;
  invoiceUrl?: string;
}) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-white p-8 text-center shadow-lg ring-1 ring-black/5">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gaa-green/10 text-3xl">
          ✅
        </div>
        <h2 className="text-2xl font-bold text-gaa-green-dark">Thank you!</h2>
        <p className="mt-2 text-gray-600">
          Your registration for the Longford GAA Golf Classic 2026 has been
          received. We&apos;ll be in touch about tee times.
        </p>
      </div>

      {method === "invoice" ? (
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <h3 className="text-lg font-bold text-gaa-green-dark">
            Your invoice is on its way
          </h3>
          <p className="mt-1 text-sm text-gray-600">
            We&apos;ve emailed a formal invoice, payable within 30 days. You can
            settle it by card or bank transfer from the link in that email.
          </p>
          {invoiceUrl && (
            <a
              href={invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block rounded-lg bg-gaa-green px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-gaa-green-dark"
            >
              View and pay your invoice
            </a>
          )}
        </div>
      ) : (
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <h3 className="text-lg font-bold text-gaa-green-dark">
            Payment by bank transfer
          </h3>
          <p className="mt-1 text-sm text-gray-600">
            To complete your entry, please transfer the total amount due to the
            account below. Use your name as the payment reference.
          </p>
          <div className="mt-4 space-y-2">
            <CopyValue label="Account name" value="Longford County Board GAA" />
            <CopyValue label="IBAN" value="IE31IPBS99073152079039" />
            <CopyValue label="BIC" value="IPBSIE2D" />
          </div>
        </div>
      )}
    </div>
  );
}
