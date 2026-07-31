-- Longford GAA Golf Classic 2026 — Stripe payments migration
-- Run this in the Supabase SQL Editor after supabase/schema.sql.
-- Safe to re-run.

alter table public.registrations
  add column if not exists payment_method             text        not null default 'transfer',
  add column if not exists payment_status             text        not null default 'pending',
  add column if not exists amount_paid                numeric     not null default 0,
  add column if not exists paid_at                    timestamptz,
  add column if not exists stripe_customer_id         text,
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_payment_intent_id   text,
  add column if not exists stripe_invoice_id          text,
  add column if not exists stripe_invoice_url         text,
  add column if not exists stripe_invoice_number      text;

alter table public.registrations drop constraint if exists registrations_payment_method_check;
alter table public.registrations add constraint registrations_payment_method_check
  check (payment_method in ('card', 'invoice', 'transfer'));

alter table public.registrations drop constraint if exists registrations_payment_status_check;
alter table public.registrations add constraint registrations_payment_status_check
  check (payment_status in ('pending', 'paid', 'failed'));

-- The webhook looks rows up by these, so keep them indexed.
create index if not exists registrations_stripe_session_idx
  on public.registrations (stripe_checkout_session_id);
create index if not exists registrations_stripe_invoice_idx
  on public.registrations (stripe_invoice_id);

-- Harden the public insert policy.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships to the browser, so anyone can call this
-- policy directly rather than going through the form. Previously `with check
-- (true)` meant they could insert a row claiming payment_status = 'paid'.
-- Only the webhook — which uses the service-role key and bypasses RLS — is
-- allowed to record money as received.
drop policy if exists "Anyone can submit a registration" on public.registrations;
create policy "Anyone can submit a registration"
  on public.registrations
  for insert
  to anon, authenticated
  with check (
    payment_status = 'pending'
    and amount_paid = 0
    and paid_at is null
    and stripe_customer_id is null
    and stripe_checkout_session_id is null
    and stripe_payment_intent_id is null
    and stripe_invoice_id is null
  );

-- Webhook idempotency ledger.
--
-- Stripe guarantees at-least-once delivery: it retries on any non-2xx, and can
-- occasionally deliver the same event twice even on success. Claiming the
-- event id here before processing means a replay can never double-count a
-- payment.
create table if not exists public.stripe_events (
  id          text primary key,   -- Stripe's evt_... identifier
  type        text not null,
  received_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
-- Deliberately no policies: only the service-role key may read or write this.
