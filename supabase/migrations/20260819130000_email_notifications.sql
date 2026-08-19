-- Confirmation-email idempotency.
--
-- A card checkout with invoice_creation enabled emits TWO paid events —
-- checkout.session.completed and invoice.paid — and both legitimately reach
-- markPaid(). The stripe_events ledger dedupes redeliveries of one event but
-- cannot dedupe across two different ones, so without this the payer would
-- receive their receipt twice.
--
-- The webhook claims the send with `update ... where paid_confirmation_sent_at
-- is null returning *`, which Postgres settles atomically: exactly one caller
-- gets a row back even if both events land at the same instant.
--
-- Safe to re-run.

alter table public.registrations
  add column if not exists paid_confirmation_sent_at timestamptz;
