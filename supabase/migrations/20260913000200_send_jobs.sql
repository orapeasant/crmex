-- CRMEX send_jobs: sends queued (e.g. from the browser) and executed by the
-- sender's own phone.
-- Source: docs/spec/crmex.md §15.10. Tests: docs/spec/test-plan.md §18 (TEN-23..).
-- Depends on 20260913000000_multi_tenancy.sql and 20260913000100_crm_core.sql.
--
-- Lifecycle (enforced by trigger for every writer, service role included):
--   queued  -> claimed    (claimed_at := now())
--   queued  -> cancelled  (finished_at := now())
--   claimed -> done|failed (finished_at := now())
-- Nothing else. org_id, created_by, body, media_path, recipients and
-- created_at are immutable after insert; claimed_at/finished_at are set by
-- the trigger only. An update that leaves status unchanged must change
-- `error` and nothing else; a no-op update (e.g. claimed -> claimed) raises.
-- If the creator's account is deleted, created_by becomes NULL and the job is
-- frozen: no further update by anyone.
--
-- RLS: any firm member reads the firm's jobs; only the creator (still a
-- member) inserts or changes one, because only the creator's phone holds the
-- WhatsApp account the job runs on. There is no delete policy.
--
-- Atomic claim (§15.10): the phone runs
--   update send_jobs set status = 'claimed'
--   where id = :id and status = 'queued' and created_by = auth.uid()
--   returning *;
-- Under concurrency Postgres re-evaluates the WHERE on the locked row, so a
-- second claimer updates zero rows (check: exactly one row returned); a
-- claimed -> claimed update without the status filter raises instead.
--
-- message_history.batch_id equals the job id for job-dispatched sends. No
-- foreign key: sends started on the phone itself use a batch_id that has no
-- send_jobs row, so an FK would reject them.

create table if not exists send_jobs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  -- Nullable only so the job survives deletion of the creator's account
  -- (§15.6); inserts must set it (trigger + RLS), and a null-creator job is
  -- frozen (trigger) and matches no update policy (created_by = auth.uid()).
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  status           text not null default 'queued'
                     check (status in ('queued', 'claimed', 'done', 'cancelled', 'failed')),
  body             text,
  media_path       text,
  recipients       jsonb not null
                     check (case when jsonb_typeof(recipients) = 'array'
                                 then jsonb_array_length(recipients) > 0
                                 else false end),
  recipient_count  integer generated always as (jsonb_array_length(recipients)) stored,
  claimed_at       timestamptz,
  finished_at      timestamptz,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint send_jobs_content_check
    check (nullif(btrim(body), '') is not null or nullif(btrim(media_path), '') is not null)
);

create index if not exists send_jobs_org_created_idx on send_jobs (org_id, created_at desc);
create index if not exists send_jobs_creator_status_idx on send_jobs (created_by, status);

-- Runs with the caller's rights (like tasks_check_assignee): the client_id
-- lookup sees only the caller's firms, so it cannot be used to probe another
-- firm's client ids.
create or replace function public.send_jobs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'queued' then
      raise exception 'send_jobs must be inserted as queued' using errcode = '23514';
    end if;
    if new.created_by is null then
      raise exception 'send_jobs.created_by is required' using errcode = '23502';
    end if;
    new.claimed_at := null;
    new.finished_at := null;

    if jsonb_typeof(new.recipients) is distinct from 'array' then
      raise exception 'recipients must be a JSON array' using errcode = '23514';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.recipients) r
      where jsonb_typeof(r) <> 'object'
         or jsonb_typeof(r -> 'jid') is distinct from 'string'
         or btrim(r ->> 'jid') = ''
         or (jsonb_typeof(r -> 'client_id') is not null
             and jsonb_typeof(r -> 'client_id') <> 'null'
             and (jsonb_typeof(r -> 'client_id') <> 'string'
                  or (r ->> 'client_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    ) then
      raise exception 'each recipient needs a string jid and a null or uuid client_id' using errcode = '23514';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.recipients) r
      where r ->> 'client_id' is not null
        and not exists (select 1 from public.clients c
                        where c.id = (r ->> 'client_id')::uuid and c.org_id = new.org_id)
    ) then
      raise exception 'recipient client_id is not a client of this firm' using errcode = '23503';
    end if;
    return new;
  end if;

  -- UPDATE
  -- Creator's account deleted: ON DELETE SET NULL nulls created_by and
  -- changes nothing else. Allow exactly that.
  if old.created_by is not null and new.created_by is null
     and new.status is not distinct from old.status
     and new.error  is not distinct from old.error
     and new.org_id is not distinct from old.org_id
     and new.body   is not distinct from old.body
     and new.media_path is not distinct from old.media_path
     and new.recipients is not distinct from old.recipients
     and new.created_at is not distinct from old.created_at then
    new.claimed_at := old.claimed_at;
    new.finished_at := old.finished_at;
    return new;
  end if;
  -- A job whose creator is gone can never be claimed, cancelled or finished
  -- by anyone (service role included): only that account's phone could run it.
  if old.created_by is null then
    raise exception 'send_jobs row has no creator and cannot be updated' using errcode = '42501';
  end if;

  if new.org_id     is distinct from old.org_id
  or new.created_by is distinct from old.created_by
  or new.body       is distinct from old.body
  or new.media_path is distinct from old.media_path
  or new.recipients is distinct from old.recipients
  or new.created_at is distinct from old.created_at then
    raise exception 'send_jobs content is immutable after insert' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    new.claimed_at := old.claimed_at;
    new.finished_at := old.finished_at;
    if old.status = 'queued' and new.status = 'claimed' then
      new.claimed_at := now();
    elsif old.status = 'queued' and new.status = 'cancelled' then
      new.finished_at := now();
    elsif old.status = 'claimed' and new.status in ('done', 'failed') then
      new.finished_at := now();
    else
      raise exception 'invalid send_jobs transition % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  else
    -- Status unchanged: only `error` may change. A bare re-claim
    -- (claimed -> claimed, e.g. a second device that forgot the
    -- status = 'queued' filter) must fail loudly rather than "succeed".
    if new.error is not distinct from old.error then
      raise exception 'invalid send_jobs transition % -> %', old.status, new.status
        using errcode = '23514';
    end if;
    new.claimed_at := old.claimed_at;
    new.finished_at := old.finished_at;
  end if;
  return new;
end;
$$;

create or replace trigger send_jobs_guard before insert or update on send_jobs
  for each row execute function public.send_jobs_guard();
create or replace trigger send_jobs_guard_org_id before update on send_jobs
  for each row execute function public.guard_org_id();
create or replace trigger send_jobs_set_updated_at before update on send_jobs
  for each row execute function public.set_updated_at();

revoke all on send_jobs from anon;
revoke all on send_jobs from authenticated;
grant select, insert, update on send_jobs to authenticated;
grant all on send_jobs to service_role;

alter table send_jobs enable row level security;

drop policy if exists send_jobs_select on send_jobs;
create policy send_jobs_select on send_jobs
  for select to authenticated using (public.is_org_member(org_id));

drop policy if exists send_jobs_insert on send_jobs;
create policy send_jobs_insert on send_jobs
  for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = auth.uid() and status = 'queued');

drop policy if exists send_jobs_update on send_jobs;
create policy send_jobs_update on send_jobs
  for update to authenticated
  using (created_by = auth.uid() and public.is_org_member(org_id))
  with check (created_by = auth.uid() and public.is_org_member(org_id));

-- Realtime (postgres_changes). Supabase Realtime applies the subscriber's
-- SELECT policies, so members receive only their firms' jobs; the client
-- should still filter by org_id / created_by. Guarded for databases without
-- the publication (local tooling, PGlite).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime'
                       and schemaname = 'public' and tablename = 'send_jobs') then
    alter publication supabase_realtime add table public.send_jobs;
  end if;
end;
$$;
