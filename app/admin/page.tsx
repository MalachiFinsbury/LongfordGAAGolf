import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminClient } from "@/lib/supabase";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { type Registration } from "@/lib/types";
import { logout } from "@/app/actions";
import Dashboard from "./Dashboard";

export const metadata = { title: "Registrations — Longford GAA Golf Classic" };
export const dynamic = "force-dynamic";

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

  if (loadError) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-gaa-green-dark">
            Golf Classic 2026 — Registrations
          </h1>
          <form action={logout}>
            <button className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50">
              Sign out
            </button>
          </form>
        </div>
        <div className="rounded-xl bg-red-50 p-6 text-red-700 ring-1 ring-red-200">
          <p className="font-semibold">Could not load registrations.</p>
          <p className="mt-1 text-sm">{loadError}</p>
          <p className="mt-2 text-sm">
            Check that your Supabase env vars are set and the <code>registrations</code> table
            exists (run <code>supabase/schema.sql</code>).
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="w-full py-0">
      <Dashboard registrations={registrations} />
    </main>
  );
}
