-- CRMEX core schema: message history, image sessions, contact metadata.
-- Source: docs/spec/crmex.md §3.1 (schema verbatim) + §4 (user isolation).
--
-- These tables are the ones a client reads/writes directly via
-- @supabase/supabase-js using the user's own session (RLS-protected).
-- core-server never uses RLS for its own access (it holds the service role
-- key, which bypasses RLS) but every core-server query must still filter by
-- the JWT-derived user_id in application code — RLS here is the client-side
-- and defense-in-depth control, not the only control (see §4).

-- Send history: one row per recipient per send
-- user_id defaults to auth.uid() on the tables the app writes directly, so a
-- client insert never carries a user_id of its own; RLS still checks it. A
-- service-role write has no auth.uid() and must set user_id explicitly.
create table if not exists message_history (
  id            bigserial primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  jid           text not null,              -- normalized WhatsApp JID
  display_name  text,                       -- denormalized for history readability
  body          text,                       -- caption or text-only message
  media_path    text,                       -- storage object path (§3.3), null if text-only
  media_sha256  text,
  status        text not null default 'PENDING',  -- PENDING | SENT | FAILED | SKIPPED
  error_reason  text,
  batch_id      uuid not null,              -- groups one user-initiated send
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Image generation / refinement sessions
create table if not exists image_sessions (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  prompt_history  jsonb not null default '[]',   -- [{role, prompt, timestamp}]
  current_path    text,                          -- storage object path (§3.3)
  source          text not null,                 -- 'generated' | 'searched'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Optional per-contact metadata the user adds, used to sharpen NL matching
create table if not exists contact_meta (
  id            bigserial primary key,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  jid           text not null,
  tags          text[],
  notes         text,
  unique (user_id, jid)
);

-- Helpful indexes for per-user scoped queries (not in the spec's SQL block,
-- but every query in the system is scoped by user_id, so these pay for
-- themselves immediately; they do not change the schema's shape).
create index if not exists message_history_user_id_idx on message_history (user_id, created_at desc);
create index if not exists message_history_batch_id_idx on message_history (batch_id);
create index if not exists image_sessions_user_id_idx on image_sessions (user_id, updated_at desc);
create index if not exists contact_meta_user_id_idx on contact_meta (user_id);

alter table message_history enable row level security;
alter table image_sessions  enable row level security;
alter table contact_meta    enable row level security;

create policy own_rows on message_history
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on image_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on contact_meta
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
