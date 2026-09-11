"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  markPaidByPayer,
  submitRegistration,
  type ClaimPaidState,
  type SubmitState,
} from "./actions";
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
  OFFERED_PAYMENT_METHODS,
  DEFAULT_PAYMENT_METHOD,
  CLUB_BANK,
  calculateTotal,
  formatEuro,
  isOfferedPaymentMethod,
  type PaymentMethod,
} from "@/lib/types";

/**
 * The one method left on offer, if there is only one. A radio group with a
 * single choice asks a question the payer has no way to answer, so that case
 * is rendered as a statement instead — see the payment section below.
 */
const SOLE_METHOD: PaymentMethod | null =
  OFFERED_PAYMENT_METHODS.length === 1 ? OFFERED_PAYMENT_METHODS[0] : null;

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

/** How each method describes itself, wherever it happens to be shown. */
const PAYMENT_COPY: Record<
  PaymentMethod,
  { icon: string; title: string; blurb: string }
> = {
  card: {
    icon: "💳",
    title: "Pay now by card",
    blurb: "Secure Stripe checkout. Instant confirmation and an emailed receipt.",
  },
  invoice: {
    icon: "🧾",
    title: "Send me an invoice",
    blurb:
      "We'll email a formal invoice, payable within 30 days. Best if a company is sponsoring.",
  },
  transfer: {
    icon: "🏦",
    title: "Bank transfer",
    blurb: "We'll show you the club's account details to pay manually.",
  },
};

function PaymentOption({
  value,
  selected,
  onSelect,
}: {
  value: PaymentMethod;
  selected: PaymentMethod;
  onSelect: (m: PaymentMethod) => void;
}) {
  const { icon, title, blurb } = PAYMENT_COPY[value];
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
  const [payMethod, setPayMethod] =
    useState<PaymentMethod>(DEFAULT_PAYMENT_METHOD);

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
        // Checked for presence, not truthiness: "no team — sponsorship only"
        // is stored as 0, and a falsy test would silently reinstate the
        // default of one team when the payer came back from Stripe.
        if (typeof draft.numTeams === "number") setNumTeams(draft.numTeams);
        if (draft.teeBox) setTeeBox(draft.teeBox);
        if (draft.green) setGreen(draft.green);
        if (draft.donation) setDonation(draft.donation);
        if (draft.sponsorRaffle) setSponsorRaffle(true);
        // A draft saved while a method was still on offer must not reinstate
        // it after it has been withdrawn — that would leave no radio selected
        // and the submit button labelled for a route the payer cannot take.
        if (draft.payMethod && isOfferedPaymentMethod(draft.payMethod)) {
          setPayMethod(draft.payMethod);
        }
        pendingFields.current = draft.fields ?? null;
      }
    } catch {
      sessionStorage.removeItem(DRAFT_KEY);
    }
    setDraftLoaded(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  /** Writes saved text back into the inputs React does not own. */
  const applyFields = useCallback((fields: Record<string, string>) => {
    const form = formRef.current;
    if (!form) return;
    for (const [name, value] of Object.entries(fields)) {
      if (CONTROLLED_FIELDS.has(name)) continue;
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.value = value;
      }
    }
  }, []);

  // Second pass: the player rows are on the page now, so put the text back.
  useEffect(() => {
    if (!draftLoaded || !pendingFields.current) return;
    applyFields(pendingFields.current);
    pendingFields.current = null;
  }, [draftLoaded, numTeams, sponsorRaffle, applyFields]);

  /**
   * Puts the DOM back in step with React for the fields React controls.
   *
   * A form reset changes those inputs behind React's back. React compares
   * against its own last render, sees the value it already believes is there,
   * and so never corrects them — leaving the select reading "No team" beside a
   * total, and two team blocks, that say otherwise.
   */
  const resyncControlled = useCallback(() => {
    const form = formRef.current;
    if (!form) return;

    const set = (name: string, value: string) => {
      const el = form.elements.namedItem(name);
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        el.value = value;
      }
    };

    set("number_of_teams", String(numTeams));
    set("tee_box_count", String(teeBox));
    set("green_count", String(green));
    set("donation_amount", donation ? String(donation) : "");

    const raffle = form.elements.namedItem("sponsor_raffle");
    if (raffle instanceof HTMLInputElement) raffle.checked = sponsorRaffle;

    // A radio group comes back as a RadioNodeList; the sole-method case is a
    // hidden input, which a reset restores to the same value anyway.
    const method = form.elements.namedItem("payment_method");
    if (method instanceof RadioNodeList) {
      for (const radio of method) {
        if (radio instanceof HTMLInputElement) radio.checked = radio.value === payMethod;
      }
    }
  }, [numTeams, teeBox, green, donation, sponsorRaffle, payMethod]);

  // React resets a form once its action has completed, whatever the result. On
  // a *rejected* submission that emptied every field the payer had just filled
  // in — name, email, mobile, and all four players on every team — and put the
  // controlled selects back to their first option while React state kept the
  // real values, so the page showed "No team" above a €4,400 total and a
  // resubmit would have posted the zero that was in the DOM. The draft still
  // holds the text; React still holds the rest.
  //
  // Keyed on the state object rather than on `state.error`, because two
  // identical refusals in a row are two separate submissions and both reset.
  useEffect(() => {
    if (state.ok || !state.error) return;
    resyncControlled();
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Draft;
      if (saved.fields) applyFields(saved.fields);
    } catch {
      // Nothing recoverable — better a blank form than a broken one.
    }
  }, [state, applyFields, resyncControlled]);

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
      <Confirmation
        method={state.method ?? "transfer"}
        invoiceUrl={state.invoiceUrl}
        amountDue={state.amountDue}
        payerName={state.payerName}
        reference={state.reference}
        registrationId={state.registrationId}
      />
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
            {/* Zero is a real answer. A tee-box sponsor, a donor, or someone
                offering only a raffle prize had no way through this form
                without buying a team entry they did not want. */}
            <option value={0}>No team — sponsorship or donation only</option>
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
          {SOLE_METHOD ? "How to pay" : "How would you like to pay?"}
        </h2>
        {SOLE_METHOD ? (
          <>
            {/* Still posted as a field. The server reads the method from the
                form data, and an absent one would have to be inferred. */}
            <input type="hidden" name="payment_method" value={SOLE_METHOD} />
            <div className="rounded-xl border border-gaa-green/30 bg-gaa-green/5 p-4">
              <p className="text-sm font-semibold text-gray-900">
                {PAYMENT_COPY[SOLE_METHOD].icon} {PAYMENT_COPY[SOLE_METHOD].title}
              </p>
              <p className="mt-0.5 text-xs text-gray-600">
                {PAYMENT_COPY[SOLE_METHOD].blurb}
              </p>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            {OFFERED_PAYMENT_METHODS.map((method) => (
              <PaymentOption
                key={method}
                value={method}
                selected={payMethod}
                onSelect={setPayMethod}
              />
            ))}
          </div>
        )}
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

/** The "I have paid" button, and what it becomes once pressed. */
function ClaimPaidButton({ registrationId }: { registrationId: string }) {
  const [state, action] = useActionState<ClaimPaidState, FormData>(markPaidByPayer, {});

  if (state.ok) {
    return (
      <div
        role="status"
        className="rounded-lg bg-gaa-green/10 px-4 py-3 text-center text-sm font-medium text-gaa-green-dark ring-1 ring-gaa-green/30"
      >
        Thanks — we&apos;ve noted that you&apos;ve sent it. We&apos;ll confirm by
        email once it reaches the club account.
      </div>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="registration_id" value={registrationId} />
      <ClaimPaidSubmit />
      {state.error && (
        <p role="alert" className="mt-2 text-center text-xs font-medium text-red-700">
          {state.error}
        </p>
      )}
      <p className="mt-2 text-center text-xs text-gray-500">
        Only press this once you&apos;ve actually made the transfer — an organiser
        checks it against the club&apos;s bank statement.
      </p>
    </form>
  );
}

function ClaimPaidSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gaa-green px-6 py-3 text-base font-semibold text-white shadow-md transition hover:bg-gaa-green-dark disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Saving…" : "I have paid"}
    </button>
  );
}

function Confirmation({
  method,
  invoiceUrl,
  amountDue,
  payerName,
  reference,
  registrationId,
}: {
  method: PaymentMethod;
  invoiceUrl?: string;
  amountDue?: number;
  payerName?: string;
  reference?: string;
  registrationId?: string;
}) {
  const [open, setOpen] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes it, and the page behind must not scroll while it is up.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  const details = (
    <>
      {amountDue !== undefined && amountDue > 0 && (
        <div className="rounded-xl bg-gaa-gold/15 px-5 py-4 text-center ring-1 ring-gaa-gold/50">
          <p className="text-xs font-semibold uppercase tracking-wide text-gaa-green-dark">
            Amount to pay
          </p>
          <p className="mt-0.5 text-4xl font-bold tabular-nums text-gaa-green-dark">
            {formatEuro(amountDue)}
          </p>
        </div>
      )}

      {method === "invoice" && invoiceUrl && (
        <a
          href={invoiceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block rounded-lg bg-gaa-green px-5 py-3 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-gaa-green-dark"
        >
          Pay now by card
        </a>
      )}

      <p className="mb-2 mt-5 text-sm font-semibold text-gray-900">
        {method === "invoice"
          ? "Or transfer to the club account"
          : "Transfer to the club account"}
      </p>
      <div className="space-y-2">
        <CopyValue label="Account name" value={CLUB_BANK.accountName} />
        <CopyValue label="IBAN" value={CLUB_BANK.iban} />
        <CopyValue label="BIC" value={CLUB_BANK.bic} />
        {/* Without this the money arrives as an unattributable credit, and the
            organisers cannot tell whose place it paid for. */}
        {payerName && <CopyValue label="Payment reference — use this" value={payerName} />}
      </div>

      <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
        Please use{" "}
        <span className="font-bold">{payerName ? `"${payerName}"` : "your own name"}</span> as the
        payment reference, so we can match your transfer to your entry and confirm
        your place.
      </p>
    </>
  );

  return (
    <>
      {/* What sits behind the modal, and what remains once it is dismissed. The
          payer can reopen it, so the IBAN is never only inside something they
          have already closed. */}
      <div className="space-y-5">
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
          <h2 className="text-xl font-bold text-gaa-green-dark">
            Thanks — we have your details
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Your registration has been received, but your place is not secured
            until payment reaches the club.
          </p>
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-4 rounded-lg bg-gaa-green px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-gaa-green-dark"
            >
              Show payment details
            </button>
          )}
        </div>

        {!open && (
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">{details}</div>
        )}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 py-8 backdrop-blur-sm"
          onClick={(e) => {
            // A click on the backdrop closes; one inside the panel does not.
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pay-modal-title"
            className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl ring-2 ring-gaa-gold"
          >
            <div className="relative bg-gaa-green-dark px-6 py-5 text-center">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-gaa-gold">
                Action required
              </p>
              <h2 id="pay-modal-title" className="mt-1.5 text-2xl font-bold text-white">
                Your place is not secured until you pay
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-white/80">
                Team places are held in the order payment arrives. Please make the
                bank transfer below to confirm your slot.
              </p>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="absolute right-3 top-3 rounded-md px-2 py-1 text-lg leading-none text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                ×
              </button>
            </div>

            <div className="px-6 py-6">
              {details}

              <div className="mt-6 border-t border-gray-200 pt-5">
                {registrationId && <ClaimPaidButton registrationId={registrationId} />}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-6 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  I&apos;ll pay later
                </button>
              </div>

              <p className="mt-4 text-center text-xs text-gray-500">
                We&apos;ve emailed these payment details to you too.
                {reference && (
                  <>
                    {" "}
                    Your entry reference is{" "}
                    <span className="font-mono font-semibold">{reference}</span>.
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
