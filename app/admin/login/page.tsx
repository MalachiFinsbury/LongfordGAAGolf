import LoginForm from "./LoginForm";

export const metadata = { title: "Organiser login — Longford GAA Golf Classic" };

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg ring-1 ring-black/5">
        <div className="mb-6 text-center">
          <p className="mb-2 inline-block rounded-full bg-gaa-gold px-3 py-1 text-xs font-bold uppercase tracking-wide text-gaa-green-dark">
            Longford GAA
          </p>
          <h1 className="text-xl font-bold text-gaa-green-dark">Organiser login</h1>
          <p className="mt-1 text-sm text-gray-500">
            Golf Classic 2026 registrations
          </p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
