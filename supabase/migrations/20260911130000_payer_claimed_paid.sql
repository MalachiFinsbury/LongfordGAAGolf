-- Let a payer tell the club they have sent the bank transfer.
--
-- Transfers go straight to the club's own account, so nothing in the system
-- learns about them until a volunteer reads the statement. The confirmation
-- screen now shows the IBAN and an "I have paid" button, and this column is
-- where that button's claim lands.
--
-- It is deliberately NOT `payment_status`, and deliberately not part of any
-- collected total. The endpoint that writes it is public — the payer has no
-- login — so this is an unverified assertion by whoever had the registration
-- id, nothing more. Three sources of truth, in descending order of authority:
--
--   payment_recorded_by = 'stripe'     Stripe settled it against the bank rails
--   payment_recorded_by = 'organiser'  a volunteer matched it to a statement
--   payer_claimed_paid_at              the payer says they sent it
--
-- The dashboard shows the third as a prompt to go and check, which is all it
-- is worth. Treating it as payment would let anyone mark their own entry paid.
--
-- Safe to re-run.

alter table public.registrations
  add column if not exists payer_claimed_paid_at timestamptz;

-- The organisers' chase-up list is ordered by this: someone who says they have
-- paid is worth checking the statement for before someone who has gone quiet.
create index if not exists registrations_payer_claimed_idx
  on public.registrations (payer_claimed_paid_at)
  where payer_claimed_paid_at is not null;

-- Deliberately NOT touching the anon insert policy.
--
-- The obvious thing here is to re-create it with `payer_claimed_paid_at is
-- null` added to the check, the way 20260911120000 pinned the other columns.
-- That would be a bug: 20260911120100 removes that policy for good and revokes
-- INSERT from anon entirely, so a `create policy` in this file would hand the
-- public write path back the moment this migration ran after that one — and
-- migrations get replayed against fresh environments in timestamp order, so it
-- always would.
--
-- Leaving it alone is safe in both orders. Run before 20260911120100, the
-- policy is briefly able to set this column — worth nothing, since the whole
-- point of `payer_claimed_paid_at` is that it is an unverified claim the club
-- checks against a statement. Run after, there is no policy and no grant, and
-- nothing but the service-role key can write the column at all.
