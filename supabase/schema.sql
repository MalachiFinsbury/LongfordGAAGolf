-- Longford GAA Golf Classic 2026 — database schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).

create table if not exists public.registrations (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),

  -- Your details
  name               text not null,
  company_or_club    text,
  address            text,
  mobile             text not null,
  email              text not null,

  -- Entry
  number_of_teams    integer not null default 0,
  teams              jsonb   not null default '[]'::jsonb, -- [{ players: [{ name, handicap }] }]

  -- Additional sponsorship / donation
  tee_box_count      integer not null default 0,
  green_count        integer not null default 0,
  donation_amount    numeric not null default 0,
  sponsor_raffle     boolean not null default false,
  raffle_prize       text,

  -- Calculated
  total_amount       numeric not null default 0
);

-- NOTE: the payment columns live in supabase/migrations/. Apply them with
-- `supabase db push`, or paste the migration into the SQL Editor by hand.

-- Row Level Security: allow anonymous inserts (public form), block public reads.
-- The admin dashboard reads via the service-role key, which bypasses RLS.
alter table public.registrations enable row level security;

drop policy if exists "Anyone can submit a registration" on public.registrations;
create policy "Anyone can submit a registration"
  on public.registrations
  for insert
  to anon, authenticated
  with check (true);

-- No select/update/delete policies => the anon/public key cannot read the data.
