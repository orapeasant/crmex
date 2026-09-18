-- CRMEX multi-tenancy: firms (organizations) as tenants.
-- Source: docs/spec/crmex.md §15. Tests: docs/spec/test-plan.md §18 (TEN-*).
--
-- The isolation boundary for firm data moves from the user to the firm:
-- members of a firm share its rows; nothing crosses firms. Enforcement:
--   1. RLS here, via is_org_member() / has_org_role().
--   2. core-server (service role, bypasses RLS) verifies X-Org-Id against
--      org_members on every firm-scoped request and filters every query.
--   3. Storage paths <org_id>/<user_id>/<sha256>.png with folder policies.
--
-- Membership, firm creation and invitations are written ONLY by core-server
-- (service role). Clients get read access to their own firms' rows and no
-- write policies (and no write grants) on these tables, so a user can never
-- grant themselves a membership or a role.
--
-- Supabase notes that shaped this file:
--   * Supabase's default privileges GRANT ALL on new public tables and
--     EXECUTE on new public functions to anon, authenticated and service_role
--     directly. "revoke ... from public" does not remove those grants, so
--     every revoke below names anon/authenticated explicitly.
--   * Every policy is "to authenticated", so the anon role never evaluates a
--     policy (and never needs EXECUTE on the helpers) — anon simply sees
--     nothing.
--   * The service role has BYPASSRLS; nothing here restricts it except the
--     org_id immutability trigger, which core-server must also respect.
--
-- Re-runnable: tables/indexes use IF NOT EXISTS, policies are dropped before
-- being created, the contact_meta constraint swap is guarded, and the Demo
-- Firm backfill only runs the first time (a re-run must not turn accounts
-- created since then into Demo Firm owners).

-- ---------------------------------------------------------------------------
-- Tenancy tables
-- ---------------------------------------------------------------------------

create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  plan        text not null default 'free',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists org_members (
  org_id        uuid not null references organizations(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner', 'admin', 'member')),
  -- Denormalized from the verified auth user when the membership is created,
  -- so members can see each other's name/email without reading auth.users.
  email         text,
  display_name  text,
  created_at    timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_id_idx on org_members (user_id);

create table if not exists org_invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  email        text,                 -- null for a QR/link invitation not bound to an address
  role         text not null check (role in ('admin', 'member')),
  token_hash   text not null unique, -- sha256 of the token; the token itself is never stored
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id) on delete set null,
  revoked_at   timestamptz
);
create index if not exists org_invitations_org_id_idx on org_invitations (org_id);

create table if not exists org_audit_log (
  id          bigserial primary key,
  org_id      uuid not null references organizations(id) on delete cascade,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,  -- 'member.add' | 'member.remove' | 'member.role' | 'invitation.create' | ...
  entity      text,
  entity_id   text,
  created_at  timestamptz not null default now()
);
create index if not exists org_audit_log_org_id_idx on org_audit_log (org_id, created_at desc);

-- Clients may only READ tenancy tables (and only through the policies
-- below). Removing the write grants is defence in depth on top of "RLS with
-- no write policy": a policy added by mistake later still cannot open writes.
revoke all on organizations, org_members, org_invitations, org_audit_log from anon;
revoke insert, update, delete, truncate, references, trigger
  on organizations, org_members, org_invitations, org_audit_log from authenticated;
grant select on organizations, org_members, org_invitations, org_audit_log to authenticated;
grant all on organizations, org_members, org_invitations, org_audit_log to service_role;
grant usage, select on sequence org_audit_log_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Membership helpers. SECURITY DEFINER so policies on org_members itself
-- don't recurse; search_path pinned empty and every name schema-qualified.
-- They only ever answer about the CALLER (auth.uid()), so exposing them as
-- RPCs to authenticated users reveals nothing beyond the caller's own
-- memberships, which org_members RLS already shows them.
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = org and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = org and m.user_id = auth.uid() and m.role = any (roles)
  );
$$;

-- Storage folder names are text; a non-uuid folder (e.g. a legacy
-- <user_id>/ path or garbage) must deny rather than raise a cast error.
create or replace function public.is_org_member_folder(folder text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when folder ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_org_member(folder::uuid)
    else false
  end;
$$;

-- Supabase grants EXECUTE on new public functions to anon directly, so
-- revoking from PUBLIC alone would leave anon able to call these.
revoke all on function public.is_org_member(uuid)         from public, anon;
revoke all on function public.has_org_role(uuid, text[])  from public, anon;
revoke all on function public.is_org_member_folder(text)  from public, anon;
grant execute on function public.is_org_member(uuid)        to authenticated, service_role;
grant execute on function public.has_org_role(uuid, text[]) to authenticated, service_role;
grant execute on function public.is_org_member_folder(text) to authenticated, service_role;

-- A row never moves between firms — not by a member of both firms through
-- RLS (whose USING/WITH CHECK would both pass), and not by a core-server
-- bug through the service role. Shared by the CRM tables (20260913000100).
create or replace function public.guard_org_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable (% -> %)', old.org_id, new.org_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

alter table organizations   enable row level security;
alter table org_members     enable row level security;
alter table org_invitations enable row level security;
alter table org_audit_log   enable row level security;

drop policy if exists org_read on organizations;
create policy org_read on organizations
  for select to authenticated using (public.is_org_member(id));

drop policy if exists members_read on org_members;
create policy members_read on org_members
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists invitations_read on org_invitations;
create policy invitations_read on org_invitations
  for select to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));

drop policy if exists audit_read on org_audit_log;
create policy audit_read on org_audit_log
  for select to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------
-- Demo Firm: existing data moves here (decided 2026-09-13). Every account
-- that exists when this migration first runs becomes an owner of it.
-- Guarded so a re-run does not enrol accounts created afterwards.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from organizations where id = '00000000-0000-4000-8000-00000000d3e0') then
    insert into organizations (id, name)
    values ('00000000-0000-4000-8000-00000000d3e0', 'Demo Firm');

    insert into org_members (org_id, user_id, role, email, display_name)
    select '00000000-0000-4000-8000-00000000d3e0', u.id, 'owner', u.email,
           coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
    from auth.users u
    on conflict (org_id, user_id) do nothing;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Firm-scope the existing per-user tables
-- ---------------------------------------------------------------------------

alter table message_history add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table image_sessions  add column if not exists org_id uuid references organizations(id) on delete cascade;
alter table contact_meta    add column if not exists org_id uuid references organizations(id) on delete cascade;

-- Backfill before NOT NULL; the Demo Firm row above already exists.
update message_history set org_id = '00000000-0000-4000-8000-00000000d3e0' where org_id is null;
update image_sessions  set org_id = '00000000-0000-4000-8000-00000000d3e0' where org_id is null;
update contact_meta    set org_id = '00000000-0000-4000-8000-00000000d3e0' where org_id is null;

alter table message_history alter column org_id set not null;
alter table image_sessions  alter column org_id set not null;
alter table contact_meta    alter column org_id set not null;

-- §15.6: records stay with the firm when an account is deleted. user_id
-- ("sent by" / "last written by") becomes nullable and ON DELETE SET NULL
-- instead of CASCADE. Defaults (auth.uid()) and the insert checks
-- (user_id = auth.uid()) are unchanged, so a client can never write a null.
-- The FK names are the ones Postgres generated for the inline references.
alter table message_history alter column user_id drop not null;
alter table image_sessions  alter column user_id drop not null;
alter table contact_meta    alter column user_id drop not null;
alter table message_history drop constraint if exists message_history_user_id_fkey;
alter table image_sessions  drop constraint if exists image_sessions_user_id_fkey;
alter table contact_meta    drop constraint if exists contact_meta_user_id_fkey;
alter table message_history add constraint message_history_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
alter table image_sessions add constraint image_sessions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
alter table contact_meta add constraint contact_meta_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

create index if not exists message_history_org_idx on message_history (org_id, created_at desc);
create index if not exists image_sessions_org_idx  on image_sessions (org_id, updated_at desc);

create or replace trigger message_history_guard_org_id before update on message_history
  for each row execute function public.guard_org_id();
create or replace trigger image_sessions_guard_org_id before update on image_sessions
  for each row execute function public.guard_org_id();
create or replace trigger contact_meta_guard_org_id before update on contact_meta
  for each row execute function public.guard_org_id();

-- contact_meta (suppression list and tags) is now shared by the firm.
-- Before the per-firm unique key can exist, rows that several users kept for
-- the same jid (all now in the Demo Firm) must be merged, or the ADD
-- CONSTRAINT fails on any project with overlapping contacts. Tags are
-- unioned (so a 'suppressed' tag is never lost) and notes concatenated into
-- the lowest id; the other rows are deleted.
update contact_meta k
set tags  = (select array_agg(distinct t order by t)
             from contact_meta c, unnest(c.tags) t
             where c.org_id = k.org_id and c.jid = k.jid),
    notes = (select string_agg(c.notes, E'\n' order by c.id)
             from contact_meta c
             where c.org_id = k.org_id and c.jid = k.jid and nullif(btrim(c.notes), '') is not null)
where k.id in (select min(id) from contact_meta group by org_id, jid having count(*) > 1);

delete from contact_meta c
using (select org_id, jid, min(id) as keep_id
       from contact_meta group by org_id, jid having count(*) > 1) d
where c.org_id = d.org_id and c.jid = d.jid and c.id <> d.keep_id;

-- The original inline "unique (user_id, jid)" is auto-named
-- contact_meta_user_id_jid_key by Postgres.
alter table contact_meta drop constraint if exists contact_meta_user_id_jid_key;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'contact_meta_org_id_jid_key'
                   and conrelid = 'public.contact_meta'::regclass) then
    alter table public.contact_meta add constraint contact_meta_org_id_jid_key unique (org_id, jid);
  end if;
end;
$$;

-- user_id now records who last wrote the row, not who owns it. Stamp it on
-- every client update: without this, a member upserting a row another member
-- wrote (supabase-js upsert onConflict 'org_id,jid' does not send user_id)
-- would fail the "user_id = auth.uid()" WITH CHECK below. RLS checks the row
-- as modified by BEFORE triggers. Service-role writes (auth.uid() is null)
-- keep whatever user_id they set.
create or replace function public.contact_meta_stamp_writer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id := coalesce(auth.uid(), new.user_id);
  return new;
end;
$$;

create or replace trigger contact_meta_stamp_writer before update on contact_meta
  for each row execute function public.contact_meta_stamp_writer();

drop policy if exists own_rows on message_history;
drop policy if exists own_rows on image_sessions;
drop policy if exists own_rows on contact_meta;

-- Members read the firm's rows; a client-side insert must be in one of the
-- caller's firms and attributed to the caller. message_history has no client
-- update/delete policy: rows are written once, when a result is settled.
drop policy if exists firm_rows_read on message_history;
create policy firm_rows_read on message_history
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists firm_rows_insert on message_history;
create policy firm_rows_insert on message_history
  for insert to authenticated with check (public.is_org_member(org_id) and user_id = auth.uid());

drop policy if exists firm_rows_read on image_sessions;
create policy firm_rows_read on image_sessions
  for select to authenticated using (public.is_org_member(org_id));
-- image_sessions are written only by core-server (service role).

drop policy if exists firm_rows_read on contact_meta;
create policy firm_rows_read on contact_meta
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists firm_rows_insert on contact_meta;
create policy firm_rows_insert on contact_meta
  for insert to authenticated with check (public.is_org_member(org_id) and user_id = auth.uid());
drop policy if exists firm_rows_update on contact_meta;
create policy firm_rows_update on contact_meta
  for update to authenticated using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id) and user_id = auth.uid());

revoke all on message_history, image_sessions, contact_meta from anon;
revoke truncate, references, trigger on message_history, image_sessions, contact_meta from authenticated;

-- ---------------------------------------------------------------------------
-- Firm-level usage for quotas (replaces per-user usage_daily for new code).
-- RLS enabled with no policies and no client grants: only core-server
-- reads/writes it.
-- ---------------------------------------------------------------------------

create table if not exists org_usage_daily (
  org_id            uuid not null references organizations(id) on delete cascade,
  day               date not null,
  images_generated  integer not null default 0,
  messages_drafted  integer not null default 0,
  messages_sent     integer not null default 0,
  storage_bytes     bigint  not null default 0,
  primary key (org_id, day)
);
alter table org_usage_daily enable row level security;
revoke all on org_usage_daily from anon, authenticated;
grant all on org_usage_daily to service_role;

insert into org_usage_daily (org_id, day, images_generated, messages_sent, storage_bytes)
select '00000000-0000-4000-8000-00000000d3e0', day,
       sum(images_generated), sum(messages_sent), sum(storage_bytes)
from usage_daily
group by day
on conflict (org_id, day) do nothing;

insert into app_settings (key, value) values
  ('quota.default_daily_drafts', '200')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Storage: <org_id>/<user_id>/<sha256>.png, readable by the firm's members.
-- Writes and deletes stay server-side only (service role).
--
-- Objects stored before this migration live at <user_id>/<sha256>.png. They
-- are NOT moved here (Storage objects cannot be safely renamed from SQL);
-- after this migration a client session can no longer read them directly
-- (the first folder is not a firm id), only core-server via the service role.
-- ---------------------------------------------------------------------------

drop policy if exists own_images_read   on storage.objects;
drop policy if exists own_images_write  on storage.objects;
drop policy if exists own_images_delete on storage.objects;

drop policy if exists firm_images_read on storage.objects;
create policy firm_images_read on storage.objects
  for select to authenticated using (
    bucket_id = 'user-images'
    and public.is_org_member_folder((storage.foldername(name))[1])
  );
