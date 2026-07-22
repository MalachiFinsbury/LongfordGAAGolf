# Longford GAA Golf Classic 2026 — Registration site

A simple registration site built with **Next.js (App Router)**, **Supabase**, and deployable to **Vercel**. It has:

- A public registration form (a replica of the Golf Classic 2026 Jotform).
- A hardcoded **organiser login** — no user sign-up.
- An **admin dashboard** that shows every submission, neatly organised, with running totals.

---

## 1. Set up Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard go to **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the
   `registrations` table and the Row Level Security policy (anonymous users can
   submit the form but cannot read the data).
3. Go to **Settings → API** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (keep this secret)

## 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in the values:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Hardcoded admin login — change these!
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
ADMIN_SESSION_SECRET=a-long-random-string
```

## 3. Run locally

```bash
npm install
npm run dev
```

- Public form: <http://localhost:3000>
- Organiser login: <http://localhost:3000/admin> (redirects to the login page)

## 4. Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Import it at [vercel.com/new](https://vercel.com/new).
3. Add the same environment variables (from step 2) in
   **Project → Settings → Environment Variables**.
4. Deploy. That's it.

> Tip: install the CLI (`npm i -g vercel`) and run `vercel` to deploy from the
> terminal, or `vercel env pull` to sync env vars locally.

---

## How it works

| Piece | File |
| --- | --- |
| Registration form (UI) | `app/RegistrationForm.tsx` |
| Form submit + login/logout | `app/actions.ts` (server actions) |
| Admin dashboard | `app/admin/page.tsx` |
| Login page | `app/admin/login/` |
| Route protection | `proxy.ts` (Next.js proxy/middleware) |
| Hardcoded auth (signed cookie) | `lib/auth.ts` |
| Supabase clients | `lib/supabase.ts` |
| Database schema | `supabase/schema.sql` |

The admin session is a signed (HMAC-SHA256) httpOnly cookie, so it can't be
forged. The dashboard reads submissions with the Supabase **service-role** key
on the server only — it is never exposed to the browser.
