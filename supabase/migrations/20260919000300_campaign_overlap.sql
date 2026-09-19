-- CRMEX campaign overlap: is this client already getting a message today?
-- Source: docs/spec/crmex.md §18.7 (C-D6). Tests: docs/spec/test-plan.md §21 (CAM-20).
-- Depends on 20260919000000_campaigns.sql.
--
-- C-D6: above 10% shared recipients with another campaign due the same day, the
-- wizard warns and offers remove / reschedule / send anyway. It warns rather
-- than auto-excluding, because two different messages to one client on one day
-- is sometimes exactly right, and silently dropping recipients would mean the
-- user approved a list that is not the list that went out.
--
-- The rule lives here, in one function, rather than in each client. Two shells
-- render this wizard (web-ui's portal and shared-ui's app); a threshold
-- implemented twice is a threshold that will disagree with itself.

-- ---------------------------------------------------------------------------
-- organizations.timezone — "the same day" needs a day boundary
-- ---------------------------------------------------------------------------
--
-- Specified by §16.4.1 and added early because §18.7 needs it first: "due the
-- same day" is meaningless without one agreed timezone, and a UTC day would
-- split a Cairo or Singapore working day in the middle of the afternoon. §16
-- will use this same column for "09:00 on the birthday".

alter table organizations
  add column if not exists timezone text not null default 'UTC';

comment on column organizations.timezone is
  'IANA timezone name for the firm (crmex.md §16.4.1). The day boundary for '
  '§18.7 campaign overlap and, later, the wall-clock time of scheduled events.';

-- Validated against the catalog rather than a CHECK: a CHECK constraint cannot
-- query pg_timezone_names, and an unvalidated string here would surface as a
-- runtime error inside `at time zone` at send time, far from the edit that
-- caused it.
create or replace function public.validate_org_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.timezone
  ) then
    raise exception 'unknown IANA timezone: %', coalesce(new.timezone, '(null)')
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace trigger organizations_validate_timezone
  before insert or update of timezone on organizations
  for each row execute function public.validate_org_timezone();

revoke all on function public.validate_org_timezone() from public, anon;

-- ---------------------------------------------------------------------------
-- campaign_overlap()
-- ---------------------------------------------------------------------------

/**
 * Campaigns due the same firm-local day as `p_at` that would message any of
 * `p_client_ids`, with the shared client ids so the wizard can offer to remove
 * them.
 *
 * `security invoker`, like §16.5's functions: RLS still applies, so a caller
 * sees only their own firm's jobs and cannot use this to probe another firm's
 * schedule with a guessed org id.
 *
 * Only `queued` and `claimed` jobs count. A `done`, `cancelled`, `failed` or
 * `expired` campaign either already sent — in which case the client has the
 * message and a warning changes nothing — or never will.
 */
create or replace function public.campaign_overlap(
  p_org_id     uuid,
  p_client_ids uuid[],
  p_at         timestamptz default now()
)
returns table (
  job_id            uuid,
  shared_count      integer,
  shared_client_ids uuid[],
  selected_count    integer,
  overlap_pct       numeric,
  exceeds_threshold boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with firm as (
    select coalesce(nullif(btrim(o.timezone), ''), 'UTC') as tz
    from public.organizations o
    where o.id = p_org_id
  ),
  selected as (
    -- Deduplicated: the same client id passed twice must not inflate the
    -- denominator and quietly push the ratio under the threshold. Kept as a
    -- set of rows rather than an array so membership below is a plain IN —
    -- `= any ((select ...))` reads the subquery as a set, not as an array.
    select distinct c as id
    from unnest(coalesce(p_client_ids, '{}'::uuid[])) c
  ),
  selected_n as (select count(*)::integer as n from selected),
  day_of as (
    select (p_at at time zone (select tz from firm))::date as d
  ),
  shared as (
    select j.id,
           array_agg(distinct (r ->> 'client_id')::uuid) as ids
    from public.send_jobs j
    cross join lateral jsonb_array_elements(j.recipients) r
    where j.org_id = p_org_id
      and j.status in ('queued', 'claimed')
      and (coalesce(j.scheduled_at, j.created_at) at time zone (select tz from firm))::date
          = (select d from day_of)
      and jsonb_typeof(r -> 'client_id') = 'string'
      and (r ->> 'client_id')::uuid in (select id from selected)
    group by j.id
  )
  select s.id,
         coalesce(array_length(s.ids, 1), 0),
         s.ids,
         (select n from selected_n),
         case when (select n from selected_n) = 0 then 0::numeric
              else round(coalesce(array_length(s.ids, 1), 0)::numeric
                         * 100 / (select n from selected_n), 2)
         end,
         -- C-D6's 10% threshold, defined once. Strictly greater: an exact 10%
         -- is "not above 10%", and a warning that fires constantly is a warning
         -- nobody reads (§18.7).
         case when (select n from selected_n) = 0 then false
              else coalesce(array_length(s.ids, 1), 0)::numeric
                   * 100 / (select n from selected_n) > 10
         end
  from shared s
  where coalesce(array_length(s.ids, 1), 0) > 0;
$$;

revoke all on function public.campaign_overlap(uuid, uuid[], timestamptz) from public, anon;
grant execute on function public.campaign_overlap(uuid, uuid[], timestamptz)
  to authenticated, service_role;
