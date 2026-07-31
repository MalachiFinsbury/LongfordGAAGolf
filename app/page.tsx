import Image from "next/image";
import RegistrationForm from "./RegistrationForm";
import banner from "@/public/banner.jpg";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string }>;
}) {
  const { payment } = await searchParams;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
      {/* Top bar */}
      <div className="mb-4 flex justify-end">
        <a
          href="/admin"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gaa-green/40 bg-white px-4 py-2 text-sm font-semibold text-gaa-green shadow-sm transition hover:bg-gaa-green hover:text-white"
        >
          🔑 Organiser login
        </a>
      </div>

      {/* Hero banner */}
      <header className="mb-8 overflow-hidden rounded-2xl shadow-lg ring-1 ring-black/5">
        <Image
          src={banner}
          alt="The Longford GAA Golf Classic — Killeen Castle, Co. Meath, Friday 18 September 2026"
          priority
          placeholder="blur"
          className="h-auto w-full"
          sizes="(max-width: 768px) 100vw, 768px"
        />
      </header>
      <p className="mb-8 text-center text-sm text-gray-500">
        Shotgun start · 4-person teams. Entry and sponsorship directly support
        Gaelic games in County Longford.
      </p>

      {payment === "cancelled" && (
        <div className="mb-8 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <span className="font-semibold">Payment cancelled.</span> Your details
          are still here — check them over and submit again, or choose bank
          transfer instead.
        </div>
      )}

      <RegistrationForm />
    </main>
  );
}
