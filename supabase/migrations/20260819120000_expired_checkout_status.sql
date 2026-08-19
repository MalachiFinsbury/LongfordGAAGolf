-- Distinguish an abandoned Stripe Checkout from a payment still genuinely expected.
--
-- Every card payer who opened Checkout and closed the tab previously sat in the
-- organisers' "awaiting payment" list forever, indistinguishable from a sponsor
-- who has promised a bank transfer. That made both the chase-up list and the
-- outstanding total wrong, and it is why the pre-launch data had several
-- duplicate rows for the same person.
--
-- Apply this BEFORE deploying the code that writes 'expired', and before
-- subscribing checkout.session.expired on the Stripe webhook endpoint.
-- Safe to re-run.

alter table public.registrations drop constraint if exists registrations_payment_status_check;
alter table public.registrations add constraint registrations_payment_status_check
  check (payment_status in ('pending', 'paid', 'failed', 'expired'));
