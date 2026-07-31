import Link from "next/link";
import { getStripe } from "@/lib/stripe";
import { formatEuro } from "@/lib/types";
import ClearDraft from "./ClearDraft";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Payment received — Longford GAA Golf Classic 2026",
};

/**
 * Where Stripe returns card payers. This page is presentational only — the
 * registration is marked paid by the webhook, never by someone loading this
 * URL. It reads the session purely so the payer sees what they just paid.
 */
export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;

  let amount: number | null = null;
  let email: string | null = null;
  let invoiceUrl: string | null = null;
  let settled = false;

  if (sessionId) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(sessionId, {
        expand: ["invoice"],
      });
      amount = (session.amount_total ?? 0) / 100;
      email = session.customer_details?.email ?? null;
      settled = session.payment_status === "paid";

      const invoice = session.invoice;
      if (invoice && typeof invoice !== "string") {
        invoiceUrl = invoice.hosted_invoice_url ?? null;
      }
    } catch {
      // A bad or expired session id shouldn't produce an error page — fall
      // through to the generic confirmation below.
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <ClearDraft />
      <div className="rounded-2xl bg-white p-8 text-center shadow-lg ring-1 ring-black/5">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gaa-green/10 text-3xl">
          {settled ? "✅" : "⏳"}
        </div>

        <h1 className="text-2xl font-bold text-gaa-green-dark">
          {settled ? "Payment received" : "Thank you!"}
        </h1>

        <p className="mt-2 text-gray-600">
          {settled
            ? "Your entry to the Longford GAA Golf Classic 2026 is confirmed."
            : "Your payment is being processed. We'll confirm by email once it clears."}
        </p>

        {amount !== null && (
          <p className="mt-6 text-3xl font-bold text-gaa-green">
            {formatEuro(amount)}
          </p>
        )}

        {email && (
          <p className="mt-2 text-sm text-gray-500">
            A receipt is on its way to {email}.
          </p>
        )}

        <p className="mt-6 text-sm text-gray-600">
          We&apos;ll be in touch about tee times closer to Friday 18 September.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {invoiceUrl && (
            <a
              href={invoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-gaa-green/40 bg-white px-5 py-2.5 text-sm font-semibold text-gaa-green shadow-sm transition hover:bg-gaa-green hover:text-white"
            >
              View invoice
            </a>
          )}
          <Link
            href="/"
            className="rounded-lg bg-gaa-green px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-gaa-green-dark"
          >
            Back to the registration page
          </Link>
        </div>
      </div>
    </main>
  );
}
