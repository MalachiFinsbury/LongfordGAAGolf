-- Close the remaining gaps in the public insert policy.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships to every browser, so this policy is
-- reachable by anyone who opens the site — not just by the registration form.
-- The previous version pinned the payment columns but left two writable:
--
--   stripe_invoice_url    rendered by the admin dashboard as a clickable
--                         "Open in Stripe" link, and written to the CSV export.
--                         An attacker-supplied URL there is a phishing link
--                         aimed squarely at the organisers — the people holding
--                         the Stripe and bank credentials.
--   stripe_invoice_number shown as that link's text, so a convincing label for
--                         the above.
--
-- Both are set only by the webhook and the invoice path, which use the
-- service-role key and bypass RLS. Nothing arriving through the anon key has
-- any business supplying either.
--
-- Safe to re-run, and safe to apply before or after the code that accompanies
-- it: this only tightens what was already being sent.

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
    and stripe_invoice_url is null
    and stripe_invoice_number is null
  );
