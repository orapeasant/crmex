-- CRMEX campaigns: scheduled, paced bulk sends.
-- Source: docs/spec/crmex.md §18. Tests: docs/spec/test-plan.md §21 (CAM-01..17).
-- Depends on 20260913000100_crm_core.sql and 20260913000200_send_jobs.sql.
--
-- A campaign is NOT a new table. It is a send_jobs row (§15.10) plus three
-- columns saying when to start, how fast to go, and how late is too late.
-- Everything else — tenancy, the status machine, the atomic claim, the
-- batch_id link into message_history — is reused unchanged.
--
-- Two additions here carry the design weight:
--
--   1. clients.status (§18.3.1) is the firm's view of the relationship, and is
--      deliberately NOT merged with suppressed_at, which is the person's
--      instruction. Reactivating a client must never resume messaging someone
--      who opted out, so the two are separate columns with separate meanings.
--
--   2. The claim-time predicate is enforced in the TRIGGER, not only in the
--      caller's WHERE clause. §18.3 shows the claim as
--        update ... where status='queued' and scheduled_at <= now() ...
--      but RLS lets the creator update their own row, so a client that simply
--      omits those clauses would otherwise run a campaign early or past its
--      expiry. The trigger is what actually enforces the schedule, for every
--      writer including service_role; the WHERE clause is what makes the claim
--      atomic. Both are needed, for different reasons.

-- ---------------------------------------------------------------------------
-- clients.status — CRM lifecycle, distinct from consent (§18.3.1)
-- ---------------------------------------------------------------------------

alter table clients
  add column if not exists status text not null default 'active'
    check (status in ('active', 'inactive', 'archived'));

comment on column clients.status is
  'CRM lifecycle of the relationship, set by the firm: active | inactive | archived. '
  'NOT a consent field — clients.suppressed_at is the person''s opt-out (§12) and '
  'outlives any status change. Both block messaging, for different reasons.';

-- Campaign selection and the default Clients list both filter on this.
create index if not exists clients_org_status_idx on clients (org_id, status);

-- ---------------------------------------------------------------------------
-- send_jobs — when, how fast, how late (§18.3.2)
-- ---------------------------------------------------------------------------

-- All nullable: scheduled_at is null means "run as soon as the phone sees it",
-- which is exactly today's behaviour, so existing rows and the immediate-send
-- path are unaffected.
alter table send_jobs
  add column if not exists scheduled_at timestamptz,
  add column if not exists interval_ms  integer,
  add column if not exists jitter_pct   smallint not null default 25,
  add column if not exists expires_at   timestamptz;

comment on column send_jobs.scheduled_at is 'When the phone may start. Null = immediately (pre-§18 behaviour).';
comment on column send_jobs.interval_ms is 'Base gap between sends. Null = the firm pacing.* window (§9.4).';
comment on column send_jobs.jitter_pct is 'Randomization around interval_ms, percent (§18.3.2).';
comment on column send_jobs.expires_at is 'Past this the job is never claimed and is swept to expired (§16.4.1).';

-- §16.4.1 adds `expired` to the status machine. Declared here because §18
-- needs it and §16 may land later; the check is replaced idempotently.
alter table send_jobs drop constraint if exists send_jobs_status_check;
alter table send_jobs add constraint send_jobs_status_check
  check (status in ('queued', 'claimed', 'done', 'cancelled', 'failed', 'expired'));

alter table send_jobs drop constraint if exists send_jobs_jitter_check;
alter table send_jobs add constraint send_jobs_jitter_check
  check (jitter_pct between 0 and 50);

-- Upper bound only. The LOWER bound is the firm's pacing.min_interval_ms and
-- is enforced in the trigger, because it is a setting rather than a constant.
alter table send_jobs drop constraint if exists send_jobs_interval_check;
alter table send_jobs add constraint send_jobs_interval_check
  check (interval_ms is null or interval_ms <= 3600000);

-- Claiming due jobs is the phone's hot path: it polls on launch, on resume and
-- on every Realtime event.
create index if not exists send_jobs_due_idx
  on send_jobs (created_by, scheduled_at)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- The pacing floor, read from app_settings (§18.3.2)
-- ---------------------------------------------------------------------------

-- Read inside the trigger rather than trusted from the client, so a user can
-- slow a campaign down but never speed it past the firm's floor. Missing or
-- malformed settings fall back to the seeded default rather than failing the
-- insert: a campaign refusing to save because a settings row is absent would
-- be a worse failure than pacing at the default.
create or replace function public.pacing_min_interval_ms()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(value #>> '{}', '')::integer
       from public.app_settings
      where key = 'pacing.min_interval_ms'),
    10000
  );
$$;

revoke all on function public.pacing_min_interval_ms() from public, anon;
grant execute on function public.pacing_min_interval_ms() to authenticated, service_role;

insert into app_settings (key, value)
values ('pacing.min_interval_ms', '10000'::jsonb)
on conflict (key) do nothing;

-- §18.4: size ceiling for a pasted/attached image. core-server falls back to its
-- own DEFAULT_SETTINGS when this row is absent, so seeding it changes nothing on
-- its own — it exists so the value is adjustable without a deploy, which is the
-- whole point of app_settings.
insert into app_settings (key, value)
values ('quota.max_upload_bytes', '10000000'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- send_jobs_guard() — extended for the campaign columns
-- ---------------------------------------------------------------------------
--
-- Replaces the function from 20260913000200_send_jobs.sql. The original body is
-- preserved verbatim; the campaign rules are marked with §18 comments so the
-- two are easy to tell apart on a later read.

create or replace function public.send_jobs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  floor_ms integer;
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

    -- §18: pacing floor. Checked here, not as a CHECK constraint, because the
    -- floor is a firm setting that can change.
    if new.interval_ms is not null then
      floor_ms := public.pacing_min_interval_ms();
      if new.interval_ms < floor_ms then
        raise exception 'interval_ms % is below the firm pacing floor of %', new.interval_ms, floor_ms
          using errcode = '23514';
      end if;
    end if;

    -- §18: a campaign that expires before it may start can never run.
    if new.expires_at is not null
       and new.expires_at <= coalesce(new.scheduled_at, now()) then
      raise exception 'expires_at must be after scheduled_at' using errcode = '23514';
    end if;

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
     and new.created_at is not distinct from old.created_at
     -- §18: the schedule is part of "changes nothing else".
     and new.scheduled_at is not distinct from old.scheduled_at
     and new.interval_ms  is not distinct from old.interval_ms
     and new.jitter_pct   is not distinct from old.jitter_pct
     and new.expires_at   is not distinct from old.expires_at then
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
  or new.created_at is distinct from old.created_at
  -- §18.3: the schedule and pacing are immutable after insert. Rescheduling is
  -- cancel-and-recreate, so one row is always one run — a job cannot be re-timed
  -- while a phone is mid-claim, which is what keeps the atomic claim meaningful.
  or new.scheduled_at is distinct from old.scheduled_at
  or new.interval_ms  is distinct from old.interval_ms
  or new.jitter_pct   is distinct from old.jitter_pct
  or new.expires_at   is distinct from old.expires_at then
    raise exception 'send_jobs content is immutable after insert' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    new.claimed_at := old.claimed_at;
    new.finished_at := old.finished_at;
    if old.status = 'queued' and new.status = 'claimed' then
      -- §18: the schedule is enforced here, not only in the caller's WHERE
      -- clause. RLS lets the creator update their own row, so a client that
      -- omitted the predicate would otherwise start a campaign early or run one
      -- past its expiry.
      if new.scheduled_at is not null and new.scheduled_at > now() then
        raise exception 'send_jobs cannot be claimed before scheduled_at' using errcode = '23514';
      end if;
      if new.expires_at is not null and new.expires_at <= now() then
        raise exception 'send_jobs has expired and cannot be claimed' using errcode = '23514';
      end if;
      new.claimed_at := now();
    elsif old.status = 'queued' and new.status = 'cancelled' then
      new.finished_at := now();
    elsif old.status = 'queued' and new.status = 'expired' then
      -- §18/§16.4.1: the dispatcher sweep. Only for a job actually past its
      -- window — otherwise "expired" becomes a way to cancel someone else's job.
      if new.expires_at is null or new.expires_at > now() then
        raise exception 'send_jobs is not past expires_at' using errcode = '23514';
      end if;
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
