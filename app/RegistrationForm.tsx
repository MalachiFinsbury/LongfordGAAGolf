"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { submitRegistration, type SubmitState } from "./actions";
import {
  MAX_TEAMS,
  PLAYERS_PER_TEAM,
  PRICE_PER_TEAM,
  PRICE_PER_TEE_BOX,
  PRICE_PER_GREEN,
  calculateTotal,
  formatEuro,
} from "@/lib/types";

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

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-gaa-green px-6 py-3 text-base font-semibold text-white shadow-md transition hover:bg-gaa-green-dark disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Submitting…" : "Submit Registration"}
    </button>
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

  if (state.ok) {
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
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-8">
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
            <input
              id="tee_box_count"
              name="tee_box_count"
              type="number"
              min={0}
              value={teeBox || ""}
              onChange={(e) => setTeeBox(Number(e.target.value) || 0)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500">
              {formatEuro(PRICE_PER_TEE_BOX)} each
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="green_count">
              Green sponsorship
            </label>
            <input
              id="green_count"
              name="green_count"
              type="number"
              min={0}
              value={green || ""}
              onChange={(e) => setGreen(Number(e.target.value) || 0)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500">
              {formatEuro(PRICE_PER_GREEN)} each
            </p>
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
              step="0.01"
              value={donation || ""}
              onChange={(e) => setDonation(Number(e.target.value) || 0)}
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

      {state.error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-700 ring-1 ring-red-200">
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}
