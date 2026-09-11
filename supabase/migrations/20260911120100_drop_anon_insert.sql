-- Remove the public write path entirely.
--
-- APPLY THIS ONLY ONCE THE CODE THAT ACCOMPANIES IT IS LIVE. It removes the
-- last policy on `registrations`, so any deployment still inserting with the
-- anon key will start failing every registration the moment this lands. The
-- matching change is in app/actions.ts: submitRegistration now writes through
-- the service-role client, the same one it already used for the resume path
-- and for every subsequent update.
--
-- Why bother, when 20260911120000 already pinned every column that matters:
-- tightening the policy stops a forged row from *claiming* anything, but it
-- cannot stop rows being created. The anon key is public, so the registration
-- form's rate limiter — which lives in the server action — was never in the
-- path at all. Anyone could POST straight to PostgREST and fill the organisers'
-- dashboard, and the table, without ever loading the site.
--
-- With no insert policy and RLS enabled, the anon and authenticated roles can
-- do nothing to this table at all. Reads were already impossible; now writes
-- are too, and every row has to come through a server action that rate-limits,
-- validates and clamps it first.
--
-- Safe to re-run.

drop policy if exists "Anyone can submit a registration" on public.registrations;

-- Belt and braces: RLS with no policies denies everything, but an explicit
-- revoke means a future `grant all ... to anon` (Supabase's own default for new
-- tables) cannot quietly re-open this.
revoke insert, update, delete on public.registrations from anon, authenticated;
