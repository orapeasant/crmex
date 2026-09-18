-- CRMEX admin/operational schema: global settings, audit log, per-user usage
-- counters for quota enforcement.
-- Source: docs/spec/crmex.md §13.3 (verbatim).
--
-- IMPORTANT — this migration builds the DATA LAYER ONLY. Per §13 and the
-- build brief, the admin portal UI (`admin-ui`) is explicitly out of scope
-- for this phase, and core-server exposes nothing beyond a bare role-gated
-- skeleton (see core-server/src/api/admin.ts). These tables exist so the
-- enforcement points (quota checks, retention job) have somewhere to read
-- and write, and so a future admin portal has a schema to build against
-- without another migration.
--
-- All three tables have RLS enabled with NO policies, so the default is
-- deny for every role except the service role (which bypasses RLS). Only
-- core-server reaches them, via the service role key, after verifying the
-- admin claim (app_metadata.role = 'admin') on the route for app_settings /
-- admin_audit_log, or after verifying the caller's own user_id for the
-- caller's own usage_daily counters.

create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

create table if not exists admin_audit_log (
  id           bigserial primary key,
  actor_id     uuid not null references auth.users(id),
  action       text not null,          -- 'settings.update' | 'retention.run' | ...
  setting_key  text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists usage_daily (
  user_id           uuid not null references auth.users(id) on delete cascade,
  day               date not null,
  images_generated  integer not null default 0,
  messages_sent     integer not null default 0,
  storage_bytes     bigint  not null default 0,
  primary key (user_id, day)
);

alter table app_settings    enable row level security;
alter table admin_audit_log enable row level security;
alter table usage_daily     enable row level security;

-- Seed default settings so a fresh deploy is never "unlimited by accident"
-- (crmex.md §14, test-plan.md QTA-08). The admin portal (when built) only
-- changes these values later; core-server's settingsRepo also carries a
-- hardcoded copy of these same defaults as a second line of defence in case
-- a row is ever missing.
insert into app_settings (key, value) values
  ('retention.unsent_image_ttl_days', '7'),
  ('retention.sent_image_ttl_days',   '30'),
  ('quota.default_daily_images',      '50'),
  ('quota.default_storage_bytes',     '500000000'),
  ('limits.max_batch_recipients',     '200'),
  ('pacing.min_interval_ms',          '7000'),
  ('pacing.max_interval_ms',          '18000'),
  ('providers.llm',                   '"anthropic"'),
  ('providers.image_gen',             '"openai"'),
  ('providers.image_search',          '"unsplash"'),
  ('features.image_search_enabled',   'true')
on conflict (key) do nothing;
