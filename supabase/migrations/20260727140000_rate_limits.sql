-- Rate limiting for the public registration form.
--
-- The form is unauthenticated and, on the "invoice me" path, causes Stripe to
-- email an invoice to whatever address was typed in. Without a limit that is a
-- spam cannon pointed at the club's Stripe account: an attacker could mail
-- thousands of invoices from a genuine Longford GAA sender, burning the
-- account's reputation and quite possibly getting it suspended.

create table if not exists public.rate_limits (
  key          text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (key, window_start)
);

alter table public.rate_limits enable row level security;
-- No policies: reachable only via the security-definer function below.

create index if not exists rate_limits_window_idx
  on public.rate_limits (window_start);

/**
 * Atomically increments the counter for `p_key` in the current fixed window
 * and returns the new total.
 *
 * Done in SQL rather than read-then-write in the app so concurrent requests
 * cannot both observe "count = 4" and both proceed.
 */
create or replace function public.bump_rate_limit(
  p_key text,
  p_window_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits as rl (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  -- Opportunistic housekeeping so the table cannot grow without bound.
  delete from public.rate_limits
   where window_start < now() - interval '1 day';

  return v_count;
end;
$$;

revoke all on function public.bump_rate_limit(text, integer) from public, anon, authenticated;
