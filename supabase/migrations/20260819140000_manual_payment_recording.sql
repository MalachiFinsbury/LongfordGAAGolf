-- Let organisers record a bank transfer that reached the club's own account.
--
-- Transfers go directly to the club IBAN, so Stripe never sees them and the app
-- has no way to learn they happened. Without this every transfer registrant sat
-- at "awaiting payment" forever, the payer was never told their money arrived,
-- and the organisers' collected total was permanently understated.
--
-- `payment_recorded_by` keeps the two sources of truth apart: a payment Stripe
-- confirmed against the bank rails, and one a volunteer typed in after reading a
-- statement. The dashboard reports them separately rather than blurring them
-- into a single figure that looks more authoritative than it is.
--
-- Safe to re-run.

alter table public.registrations
  add column if not exists payment_recorded_by text,
  add column if not exists payment_note        text;

alter table public.registrations drop constraint if exists registrations_payment_recorded_by_check;
alter table public.registrations add constraint registrations_payment_recorded_by_check
  check (payment_recorded_by is null or payment_recorded_by in ('stripe', 'organiser'));

-- Keep the public insert policy in step: the anon key ships to the browser, so
-- a row arriving through it must not be able to claim Stripe recorded anything.
drop policy if exists "Anyone can submit a registration" on public.registrations;
create policy "Anyone can submit a registration"
  on public.registrations
  for insert
  to anon, authenticated
  with check (
    payment_status = 'pending'
    and amount_paid = 0
    and paid_at is null
    and payment_recorded_by is null
    and paid_confirmation_sent_at is null
    and stripe_customer_id is null
    and stripe_checkout_session_id is null
    and stripe_payment_intent_id is null
    and stripe_invoice_id is null
  );
