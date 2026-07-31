import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminClient } from "@/lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { formatEuro, type Registration } from "@/lib/types";
import { logout } from "@/app/actions";

export const metadata = { title: "Registrations — Longford GAA Golf Classic" };
export const dynamic = "force-dynamic";

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gaa-green-dark">{value}</p>
    </div>
  );
}

export default async function AdminPage() {
  // Belt and braces. proxy.ts already gates /admin/*, but this page reads every
  // registrant's contact details with the service-role key — too sensitive to
  // depend on a matcher config staying correct.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    redirect("/admin/login");
  }

  let registrations: Registration[] = [];
  let loadError: string | null = null;

  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("registrations")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    registrations = (data ?? []) as Registration[];
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Failed to load registrations.";
  }

  const totalTeams = registrations.reduce((s, r) => s + (r.number_of_teams || 0), 0);
  const totalRevenue = registrations.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const raffleCount = registrations.filter((r) => r.sponsor_raffle).length;

  // Only the webhook sets payment_status = 'paid', so "collected" reflects
  // money Stripe has actually confirmed — not what people said they'd pay.
  const collected = registrations
    .filter((r) => r.payment_status === "paid")
    .reduce((s, r) => s + Number(r.amount_paid || 0), 0);
  const outstanding = registrations
    .filter((r) => r.payment_status !== "paid")
    .reduce((s, r) => s + Number(r.total_amount || 0), 0);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="inline-block rounded-full bg-gaa-gold px-3 py-1 text-xs font-bold uppercase tracking-wide text-gaa-green-dark">
            Longford GAA
          </p>
          <h1 className="mt-2 text-2xl font-bold text-gaa-green-dark">
            Golf Classic 2026 — Registrations
          </h1>
        </div>
        <form action={logout}>
          <button className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50">
            Sign out
          </button>
        </form>
      </div>

      {loadError ? (
        <div className="rounded-xl bg-red-50 p-6 text-red-700 ring-1 ring-red-200">
          <p className="font-semibold">Could not load registrations.</p>
          <p className="mt-1 text-sm">{loadError}</p>
          <p className="mt-2 text-sm">
            Check that your Supabase env vars are set and the <code>registrations</code>{" "}
            table exists (run <code>supabase/schema.sql</code>).
          </p>
        </div>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Registrations" value={String(registrations.length)} />
            <StatCard label="Teams" value={String(totalTeams)} />
            <StatCard label="Raffle prizes" value={String(raffleCount)} />
            <StatCard label="Collected" value={formatEuro(collected)} />
            <StatCard label="Outstanding" value={formatEuro(outstanding)} />
          </div>
          <p className="-mt-6 mb-8 text-xs text-gray-400">
            Total pledged {formatEuro(totalRevenue)}. &ldquo;Collected&rdquo; counts
            only payments Stripe has confirmed.
          </p>

          {registrations.length === 0 ? (
            <div className="rounded-xl bg-white p-10 text-center text-gray-500 shadow-sm ring-1 ring-black/5">
              No registrations yet.
            </div>
          ) : (
            <div className="space-y-4">
              {registrations.map((r) => (
                <RegistrationCard key={r.id} r={r} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

const METHOD_LABEL: Record<string, string> = {
  card: "Card",
  invoice: "Invoice",
  transfer: "Bank transfer",
};

function PaymentBadge({ r }: { r: Registration }) {
  const method = METHOD_LABEL[r.payment_method] ?? r.payment_method;

  const tone =
    r.payment_status === "paid"
      ? "bg-green-100 text-green-800 ring-green-200"
      : r.payment_status === "failed"
        ? "bg-red-100 text-red-800 ring-red-200"
        : "bg-amber-100 text-amber-800 ring-amber-200";

  const label =
    r.payment_status === "paid"
      ? `Paid · ${method}`
      : r.payment_status === "failed"
        ? `Payment failed · ${method}`
        : `Awaiting payment · ${method}`;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${tone}`}
    >
      {label}
    </span>
  );
}

function RegistrationCard({ r }: { r: Registration }) {
  const date = new Date(r.created_at).toLocaleString("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const teams = Array.isArray(r.teams) ? r.teams : [];

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-3">
        <div>
          <p className="text-lg font-semibold text-gaa-green-dark">{r.name}</p>
          {r.company_or_club && (
            <p className="text-sm text-gray-500">{r.company_or_club}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-gaa-green">{formatEuro(Number(r.total_amount))}</p>
          <div className="mt-1 flex items-center justify-end gap-2">
            <PaymentBadge r={r} />
          </div>
          <p className="mt-1 text-xs text-gray-400">{date}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
        <div className="space-y-1 text-sm">
          <p>
            <span className="font-medium text-gray-500">Email: </span>
            <a href={`mailto:${r.email}`} className="text-gaa-green hover:underline">
              {r.email}
            </a>
          </p>
          <p>
            <span className="font-medium text-gray-500">Mobile: </span>
            <span className="text-gray-800">{r.mobile}</span>
          </p>
          {r.address && (
            <p>
              <span className="font-medium text-gray-500">Address: </span>
              <span className="text-gray-800">{r.address}</span>
            </p>
          )}
        </div>
        <div className="space-y-1 text-sm">
          <p>
            <span className="font-medium text-gray-500">Teams: </span>
            <span className="text-gray-800">{r.number_of_teams}</span>
          </p>
          {r.tee_box_count > 0 && (
            <p>
              <span className="font-medium text-gray-500">Tee box sponsorships: </span>
              <span className="text-gray-800">{r.tee_box_count}</span>
            </p>
          )}
          {r.green_count > 0 && (
            <p>
              <span className="font-medium text-gray-500">Green sponsorships: </span>
              <span className="text-gray-800">{r.green_count}</span>
            </p>
          )}
          {Number(r.donation_amount) > 0 && (
            <p>
              <span className="font-medium text-gray-500">Donation: </span>
              <span className="text-gray-800">{formatEuro(Number(r.donation_amount))}</span>
            </p>
          )}
          {r.sponsor_raffle && (
            <p>
              <span className="font-medium text-gray-500">Raffle prize: </span>
              <span className="text-gray-800">{r.raffle_prize || "Yes (unspecified)"}</span>
            </p>
          )}
          {r.stripe_invoice_url && (
            <p>
              <span className="font-medium text-gray-500">Invoice: </span>
              <a
                href={r.stripe_invoice_url}
                target="_blank"
                rel="noreferrer"
                className="text-gaa-green hover:underline"
              >
                {r.stripe_invoice_number ?? "View invoice"}
              </a>
            </p>
          )}
          {r.payment_status === "paid" && Number(r.amount_paid) > 0 && (
            <p>
              <span className="font-medium text-gray-500">Paid: </span>
              <span className="text-gray-800">{formatEuro(Number(r.amount_paid))}</span>
            </p>
          )}
        </div>
      </div>

      {teams.length > 0 && (
        <div className="border-t border-gray-100 px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((team, ti) => {
              const players = (team?.players ?? []).filter((p) => p?.name);
              if (players.length === 0) return null;
              return (
                <div key={ti} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gaa-green-dark">
                    Team {ti + 1}
                  </p>
                  <ul className="space-y-1 text-sm">
                    {players.map((p, pi) => (
                      <li key={pi} className="flex justify-between gap-2">
                        <span className="text-gray-800">{p.name}</span>
                        {p.handicap && (
                          <span className="text-gray-400">h/c {p.handicap}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
