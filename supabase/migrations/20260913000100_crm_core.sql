-- CRMEX CRM core: clients, matters, matter_clients, tasks; message_history
-- gains client_id.
-- Source: docs/spec/crmex.md §15.3. Tests: docs/spec/test-plan.md §18 (TEN-*).
-- Depends on 20260913000000_multi_tenancy.sql (organizations, is_org_member,
-- has_org_role, guard_org_id).
--
-- Clients read and write these tables directly with supabase-js under RLS;
-- there are no core-server routes for them.
--
-- Tenant integrity is enforced by the schema, not only by policy:
--   * Every table carries org_id; RLS admits a row only for members of it.
--   * Cross-row links use composite foreign keys on (id, org_id), so a
--     matter_clients row, a task's matter_id or a message's client_id can
--     never point at a row of another firm — even for the service role, and
--     even for a user who is a member of both firms.
--   * org_id is immutable after insert (guard_org_id trigger), so an UPDATE
--     can never move a row between firms. A trigger was chosen over column
--     privileges because supabase-js commonly sends the whole row (including
--     an unchanged org_id) on update; a column REVOKE would reject that, the
--     trigger only rejects an actual change.
--   * created_by is set from auth.uid() on insert (checked by RLS) and can
--     only ever change to NULL afterwards (what ON DELETE SET NULL does when
--     the account is deleted).
--   * tasks.assignee_id must be a member of the task's firm when it is set
--     or changed (trigger, so it also holds for service-role writes).
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / drop-then-create policies.

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.guard_created_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by and new.created_by is not null then
    raise exception 'created_by is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Runs with the caller's rights on purpose: an authenticated caller can only
-- see org_members rows of their own firms, so a caller writing into a firm
-- they don't belong to gets the same error whether or not the assignee is a
-- member there — no membership oracle. (Such a write is refused by RLS
-- anyway.) Only checked when the assignee is set or changed, so a task whose
-- assignee has since left the firm can still be edited or completed.
create or replace function public.tasks_check_assignee()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (select 1 from public.org_members m
                     where m.org_id = new.org_id and m.user_id = new.assignee_id) then
    raise exception 'assignee must be a member of the task''s firm' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

create table if not exists clients (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  display_name   text not null check (char_length(btrim(display_name)) between 1 and 200),
  phone_e164     text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email          text,
  kind           text not null default 'client'
                   check (kind in ('client', 'prospect', 'opposing_counsel', 'court', 'other')),
  tags           text[] not null default '{}',
  notes          text,
  opted_in_at    timestamptz,
  suppressed_at  timestamptz,
  source         text not null default 'manual' check (source in ('manual', 'phone_import')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint clients_id_org_id_key unique (id, org_id)
);

create unique index if not exists clients_org_phone_key
  on clients (org_id, phone_e164) where phone_e164 is not null;
create index if not exists clients_org_display_name_idx on clients (org_id, display_name);

-- ---------------------------------------------------------------------------
-- matters
-- ---------------------------------------------------------------------------

create table if not exists matters (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  matter_number  text not null,
  title          text not null,
  practice_area  text,
  status         text not null default 'open' check (status in ('open', 'pending', 'closed')),
  opened_on      date not null default current_date,
  closed_on      date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint matters_org_id_matter_number_key unique (org_id, matter_number),
  constraint matters_id_org_id_key unique (id, org_id)
);

create index if not exists matters_org_status_opened_idx on matters (org_id, status, opened_on desc);

-- ---------------------------------------------------------------------------
-- matter_clients
-- ---------------------------------------------------------------------------

create table if not exists matter_clients (
  matter_id   uuid not null,
  client_id   uuid not null,
  org_id      uuid not null,
  role        text not null default 'client'
                check (role in ('client', 'opposing_party', 'witness', 'other')),
  created_at  timestamptz not null default now(),
  primary key (matter_id, client_id),
  constraint matter_clients_matter_fkey foreign key (matter_id, org_id)
    references matters (id, org_id) on delete cascade,
  constraint matter_clients_client_fkey foreign key (client_id, org_id)
    references clients (id, org_id) on delete cascade
);

create index if not exists matter_clients_org_client_idx on matter_clients (org_id, client_id);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  title         text not null,
  notes         text,
  kind          text not null default 'task' check (kind in ('task', 'deadline', 'hearing')),
  status        text not null default 'open' check (status in ('open', 'done')),
  due_at        timestamptz,
  matter_id     uuid,
  assignee_id   uuid references auth.users(id) on delete set null,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- PG15+ column-list form: deleting the matter nulls only matter_id, never
  -- org_id (which is NOT NULL and part of the key).
  constraint tasks_matter_fkey foreign key (matter_id, org_id)
    references matters (id, org_id) on delete set null (matter_id)
);

create index if not exists tasks_org_status_due_idx on tasks (org_id, status, due_at);
create index if not exists tasks_matter_idx on tasks (matter_id) where matter_id is not null;

-- ---------------------------------------------------------------------------
-- message_history.client_id
-- ---------------------------------------------------------------------------

alter table message_history add column if not exists client_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'message_history_client_fkey'
                   and conrelid = 'public.message_history'::regclass) then
    alter table public.message_history
      add constraint message_history_client_fkey foreign key (client_id, org_id)
      references public.clients (id, org_id) on delete set null (client_id);
  end if;
end;
$$;

create index if not exists message_history_org_client_idx
  on message_history (org_id, client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace trigger clients_set_updated_at before update on clients
  for each row execute function public.set_updated_at();
create or replace trigger matters_set_updated_at before update on matters
  for each row execute function public.set_updated_at();
create or replace trigger tasks_set_updated_at before update on tasks
  for each row execute function public.set_updated_at();

create or replace trigger clients_guard_org_id before update on clients
  for each row execute function public.guard_org_id();
create or replace trigger matters_guard_org_id before update on matters
  for each row execute function public.guard_org_id();
create or replace trigger tasks_guard_org_id before update on tasks
  for each row execute function public.guard_org_id();
create or replace trigger matter_clients_guard_org_id before update on matter_clients
  for each row execute function public.guard_org_id();

create or replace trigger clients_guard_created_by before update on clients
  for each row execute function public.guard_created_by();
create or replace trigger matters_guard_created_by before update on matters
  for each row execute function public.guard_created_by();
create or replace trigger tasks_guard_created_by before update on tasks
  for each row execute function public.guard_created_by();

create or replace trigger tasks_check_assignee before insert or update on tasks
  for each row execute function public.tasks_check_assignee();

-- ---------------------------------------------------------------------------
-- Grants. Explicit rather than relying on Supabase's default privileges;
-- anon gets nothing, authenticated gets DML only (no TRUNCATE, which RLS
-- does not govern).
-- ---------------------------------------------------------------------------

revoke all on clients, matters, matter_clients, tasks from anon;
revoke all on clients, matters, matter_clients, tasks from authenticated;
grant select, insert, update, delete on clients, matters, matter_clients, tasks to authenticated;
grant all on clients, matters, matter_clients, tasks to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table clients        enable row level security;
alter table matters        enable row level security;
alter table matter_clients enable row level security;
alter table tasks          enable row level security;

-- clients
drop policy if exists clients_select on clients;
create policy clients_select on clients
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists clients_insert on clients;
create policy clients_insert on clients
  for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = auth.uid());
drop policy if exists clients_update on clients;
create policy clients_update on clients
  for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists clients_delete on clients;
create policy clients_delete on clients
  for delete to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));

-- matters
drop policy if exists matters_select on matters;
create policy matters_select on matters
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists matters_insert on matters;
create policy matters_insert on matters
  for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = auth.uid());
drop policy if exists matters_update on matters;
create policy matters_update on matters
  for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists matters_delete on matters;
create policy matters_delete on matters
  for delete to authenticated using (public.has_org_role(org_id, array['owner', 'admin']));

-- matter_clients (no created_by column)
drop policy if exists matter_clients_select on matter_clients;
create policy matter_clients_select on matter_clients
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists matter_clients_insert on matter_clients;
create policy matter_clients_insert on matter_clients
  for insert to authenticated with check (public.is_org_member(org_id));
drop policy if exists matter_clients_update on matter_clients;
create policy matter_clients_update on matter_clients
  for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists matter_clients_delete on matter_clients;
create policy matter_clients_delete on matter_clients
  for delete to authenticated using (public.is_org_member(org_id));

-- tasks
drop policy if exists tasks_select on tasks;
create policy tasks_select on tasks
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists tasks_insert on tasks;
create policy tasks_insert on tasks
  for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = auth.uid());
drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks
  for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists tasks_delete on tasks;
create policy tasks_delete on tasks
  for delete to authenticated using (public.is_org_member(org_id));
