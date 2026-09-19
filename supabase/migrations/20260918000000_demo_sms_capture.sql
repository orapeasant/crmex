-- Captures objects that already existed on the remote DB without a migration
-- (schema drift found 2026-09-18). Idempotent: a no-op where they exist.
-- NOTE: hard-coded to demo@adirondax.com and unused by core-server; likely a
-- leftover from another project. Candidate for removal in a later migration.

create table if not exists public.demo_sms_usage (
  user_id    text primary key check (user_id = 'demo@adirondax.com'),
  used_sms   integer not null default 0 check (used_sms >= 0 and used_sms <= 10),
  updated_at timestamptz not null default timezone('utc', now())
);
alter table public.demo_sms_usage enable row level security;

create or replace function public.consume_demo_sms()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  next_used integer;
begin
  insert into public.demo_sms_usage (user_id, used_sms, updated_at)
  values ('demo@adirondax.com', 1, timezone('utc', now()))
  on conflict (user_id) do update
    set used_sms = public.demo_sms_usage.used_sms + 1,
        updated_at = timezone('utc', now())
    where public.demo_sms_usage.used_sms < 10
  returning used_sms into next_used;

  return next_used;
end;
$function$;

revoke all on function public.consume_demo_sms() from public, anon, authenticated;
grant execute on function public.consume_demo_sms() to service_role;
