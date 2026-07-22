import Image from "next/image";
import RegistrationForm from "./RegistrationForm";
import banner from "@/public/banner.jpg";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
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

      <RegistrationForm />

      <footer className="mt-10 text-center text-xs text-gray-400">
        <a href="/admin" className="hover:text-gaa-green">
          Organiser login
        </a>
      </footer>
    </main>
  );
}
