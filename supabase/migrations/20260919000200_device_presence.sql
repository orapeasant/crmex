-- CRMEX device presence: is the gateway phone actually alive?
-- Source: docs/spec/crmex.md §18.6. Tests: docs/spec/test-plan.md §21 (CAM-21, CAM-22).
-- Depends on 20260913000000_multi_tenancy.sql.
--
-- A scheduled campaign runs only while the creator's phone is online with CRMEX
-- running (§15.10). Without this table that is an article of faith: the user
-- schedules a send for 09:00 tomorrow and finds out whether their phone was
-- awake only when the job expires. The heartbeat makes it answerable *before*
-- the scheduled time, which is the whole point.
--
-- Presence is per user and per device, not per firm: a phone belongs to a
-- person, who may be a member of several firms. The firm-scoped question
-- ("will this campaign run?") is answered by org_member_presence() below,
-- which is what enforces that one member may see another's last-seen at all.

create table if not exists device_presence (
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    text not null check (char_length(device_id) between 1 and 200),
  label        text check (label is null or char_length(label) between 1 and 100),
  last_seen_at timestamptz not null default now(),
  app_version  text check (app_version is null or char_length(app_version) <= 50),
  primary key (user_id, device_id)
);

comment on table device_presence is
  'Heartbeat from each device running CRMEX, so a scheduled campaign''s "will this run?" '
  'is answerable before its scheduled time (crmex.md §18.6). Written by the device itself.';

alter table device_presence enable row level security;

-- A user owns their own rows and nothing else. There is deliberately NO policy
-- granting another member direct SELECT: `label` ("Ahmed's personal phone") and
-- `app_version` describe the person's hardware, not the firm's work (§15.5), and
-- a row-level policy cannot hide individual columns. Cross-member reads go
-- through org_member_presence(), which returns last_seen_at and nothing else.
drop policy if exists device_presence_select_own on device_presence;
create policy device_presence_select_own on device_presence
  for select to authenticated using (user_id = auth.uid());

drop policy if exists device_presence_insert_own on device_presence;
create policy device_presence_insert_own on device_presence
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists device_presence_update_own on device_presence;
create policy device_presence_update_own on device_presence
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Sign-out on a shared device should be able to remove its row.
drop policy if exists device_presence_delete_own on device_presence;
create policy device_presence_delete_own on device_presence
  for delete to authenticated using (user_id = auth.uid());

-- The device writes `last_seen_at` itself on every heartbeat, but a client that
-- sends a time of its own (skewed clock, or deliberately) would make a dead
-- phone look alive — the one thing this table exists to prevent. The server
-- stamps it, exactly as send_jobs stamps claimed_at/finished_at (§18.3).
create or replace function public.device_presence_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.last_seen_at := now();
  return new;
end;
$$;

create or replace trigger device_presence_stamp
  before insert or update on device_presence
  for each row execute function public.device_presence_stamp();

/**
 * Last-seen time for every member of a firm, for the campaign list.
 *
 * security definer because the caller has no SELECT on another member's rows by
 * design (see the policies above). The function is the entire cross-member
 * surface, and it returns last_seen_at only — never label or app_version.
 *
 * Fails closed: a caller who is not a member of `p_org_id` gets no rows rather
 * than an error, so it cannot be used to probe which org ids exist.
 */
create or replace function public.org_member_presence(p_org_id uuid)
returns table (user_id uuid, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, max(d.last_seen_at)
  from public.org_members m
  left join public.device_presence d on d.user_id = m.user_id
  where m.org_id = p_org_id
    and public.is_org_member(p_org_id)
  group by m.user_id;
$$;

revoke all on function public.device_presence_stamp()      from public, anon;
revoke all on function public.org_member_presence(uuid)    from public, anon;
grant execute on function public.org_member_presence(uuid) to authenticated, service_role;

revoke all on device_presence from anon;
revoke all on device_presence from authenticated;
grant select, insert, update, delete on device_presence to authenticated;
grant all on device_presence to service_role;
