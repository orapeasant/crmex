# core-server

CRMEX's cloud backend. The only component that holds AI provider API keys
(crmex.md §1, invariant 1). A small, focused Express API — not a general
proxy for Supabase — implementing exactly `/api/v1/*` per the API contract:
image generation/refinement/search, NL contact matching, and the
quota/retention enforcement that has to live wherever the provider cost is
incurred.

Everything else (reading/writing `message_history` and `contact_meta`,
reading `image_sessions`, requesting fresh signed URLs for already-known
paths) happens directly from the client via `@supabase/supabase-js` with the
user's own session, protected by Postgres RLS and Storage folder-prefix
policies — core-server is not involved in those.

## Running it

```bash
npm install
cp .env.example .env   # then fill in the real values — see checklist below
npm run build
npm start               # or: npm run dev (tsx, no build step)
```

Without a real `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, `npm start`
fails immediately with a clear message naming the missing variable — it
does not crash with a stack trace. Provider env vars (`LLM_PROVIDER` etc.)
default to `fake` if unset, so the server will boot and serve `/health`
even with zero provider keys configured; every other route will error
clearly (`Unknown ... PROVIDER` at boot if you set a real provider name
without its key, or a `PROVIDER_ERROR`/`PROVIDER_TIMEOUT` response at
request time for the fake providers, which never resolve to real content).

Retention job (crmex.md §13.6) — not a scheduler, just the job:

```bash
npm run retention -- --dry-run   # preview: counts + byte totals, deletes nothing
npm run retention                # actually deletes expired objects/rows
```

Wire this into whatever your deployment already uses to run periodic jobs
(cron, a Supabase scheduled Edge Function invoking this via an internal
endpoint, a CI scheduled pipeline, etc.) — nothing in this repo runs it on a
timer by itself.

## Testing

```bash
npm test
```

Zero network access, zero real credentials. Every provider is a fake
(`test/../src/providers/*/fake.ts`, selected structurally via dependency
injection into `src/app.ts#createApp` — the same seam `LLM_PROVIDER=fake`
etc. uses at runtime). Every Supabase interaction goes through
`test/fakes/fakeSupabaseClient.ts`, a strict in-memory client that actually
enforces the RLS policies and Storage folder-prefix policies declared in
`supabase/migrations/` (not a "returns whatever you ask" mock — a client
created in `'user'` mode genuinely cannot read/write another user's rows or
objects, the same way real RLS wouldn't let it). A client created in
`'service'` mode bypasses all of that, exactly like the real service role
key does — this is what makes `test/unit/repoScoping.test.ts` meaningful:
it proves the repository layer's own `.eq('user_id', ...)` filters (not the
fake DB) are what protects a service-role connection from reading
cross-user data.

### The live suite

A fake can only show that the policies were *modelled* correctly; it can
never show that Postgres enforces them. The migrations are now applied to a
real Supabase project, and `test/live/` re-runs the isolation ground against
it through real `@supabase/supabase-js` clients:

```bash
npm run test:live     # needs LIVE_SUPABASE=1
```

It is deliberately **not** part of `npm test`: it needs credentials, it is
slow, and it writes to a shared database. It reads `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from `core-server/.env` and the anon key from
`web-ui/.env` — the anon key is required rather than optional, because the
cases that assert the `anon` role sees nothing would pass for the wrong
reason if they ran with the service role (which has `BYPASSRLS`).

Each run creates its own four accounts (A1, A2, B1 and X, who belongs to
both firms) and two firms under a per-run id, and tears all of it down
afterwards, so it never touches data already in the project.

| File | Covers |
| :--- | :--- |
| `test/live/tenancy.live.test.ts` | TEN-02..TEN-17, TEN-20 — RLS, grants, composite FKs, guard triggers |
| `test/live/storage.live.test.ts` | TEN-18, TEN-27, ISO-07 — the private bucket's folder policy |
| `test/live/sendJobs.live.test.ts` | TEN-23..TEN-25 — the `send_jobs` claim/finish lifecycle |
| `test/live/coreServer.live.test.ts` | TEN-30..TEN-33, AUTH-02/03/05 — the `X-Org-Id` gate with real JWTs |

Still not covered live, and still worth doing before production: TEN-01
(catalog audit of the RLS flag and grants, which needs direct `pg_catalog`
access rather than PostgREST), TEN-19 (the migration's backfill path, which
needs a project with pre-tenancy data), TEN-22 (account deletion), TEN-26
(the Realtime publication) and TEN-29/TEN-28/TEN-37 (Realtime and device
cases).

### Test ID coverage

Every ID in the "implement and pass" list from the build brief is present,
named exactly as the ID (e.g. `ISO-04: ...`) so it's traceable back to
`docs/spec/test-plan.md`:

| IDs | Where |
| :--- | :--- |
| ISO-01..12 | `test/integration/iso.test.ts` |
| ISO-15..19 | `test/unit/paths.test.ts` |
| ISO-20 | `test/integration/iso.test.ts` |
| ROLE-01..04 | `test/integration/role.test.ts` |
| ROLE-05 | `test/unit/roleRouteCoverage.test.ts` |
| NLM-01, 02, 03, 06 | `test/integration/nlm.test.ts` |
| NLM-04, 05 | `test/unit/contactMatcherPayload.test.ts` |
| IMG-01, 02, 03, 05, 06, 07, 08, 09, 10 | `test/integration/images.test.ts` |
| IMG-04 | `test/unit/editFallback.test.ts` |
| QTA-01..04, 06, 07, 08 | `test/integration/quota.test.ts` |
| QTA-05 | `test/integration/quota.test.ts` — **`test.skip`**, see below |
| RET-01..08 | `test/integration/retention.test.ts` |
| TEN-* (fake) | `test/integration/tenancy.test.ts` |
| TEN-* (live) | `test/live/` — see the live-suite table above |

**QTA-05 is the one skipped ID**, and not for any "needs a live project"
reason — it's structurally outside core-server. Per crmex.md §9.2, batch/`outbox` state is entirely
client-side (WebView-owned SQLite); core-server has no batch/send endpoint
at all (sending happens through the embedded Node process's IPC bridge,
which core-server never talks to). `limits.max_batch_recipients` is read
from `app_settings` — the same global table `settingsRepo` reads from here
— but the *enforcement* of "reject before writing to `outbox`" has to be
asserted in the Android client's own test suite against that setting.

AUTH-02..05 equivalents (explicitly called out in the build brief's Testing
requirements section, though not in the ID list above) are covered in
`test/integration/auth.test.ts`.

## Architecture notes / where things live

- `src/providers/types.ts` — the three narrow interfaces from crmex.md §6
  (`LlmProvider`, `ImageGenProvider`, `ImageSearchProvider`). `src/agent/`
  and `src/api/` import only these.
- `src/providers/factory.ts` — reads `LLM_PROVIDER` / `IMAGE_GEN_PROVIDER` /
  `IMAGE_SEARCH_PROVIDER` and returns the configured implementation.
  `fake` is a valid value for all three.
- Real vendor implementations: Anthropic (`src/providers/llm/anthropic.ts`),
  OpenAI (`src/providers/image-gen/openai.ts`, `images.generate` +
  `images.edit` with a fallback to an amended `generate()` per crmex.md §6),
  Unsplash (`src/providers/image-search/unsplash.ts`,
  `GET /search/photos`). None of these are exercised by the test suite —
  they're real integration code for when real keys exist, structurally
  identical in shape to their `fake.ts` counterparts.
- `src/lib/paths.ts` — storage object path construction (`buildObjectPath`,
  always `<org_id>/<user_id>/<sha256>.png` from the verified firm, JWT-derived id and a
  server-computed hash) and a defense-in-depth reference validator
  (`assertSafeReference`, rejects traversal/absolute/empty/encoded-traversal
  inputs). Nothing in the current API contract accepts a client-supplied
  storage path, so the validator isn't wired into a route today — it's
  unit-tested directly (ISO-15..18) so it's ready if a future route ever
  needs to accept one.
- `src/repositories/*` — one thin wrapper per table/bucket over the
  `SupabaseLike` interface (`src/db/types.ts`). Every method that touches a
  per-user table takes a `userId` and filters by it explicitly — this is
  the real isolation control from core-server's side, since core-server
  connects with the service role key, which bypasses RLS entirely
  (crmex.md §4).
- `src/quota/quota.ts` — checked *before* calling a provider (QTA-04): no
  cost is incurred on a request that would be rejected anyway.
- `src/lib/sessionLock.ts` — serializes concurrent refine calls on one
  session (IMG-10) in-process. **Known limitation:** this doesn't
  coordinate across multiple core-server instances. A multi-instance
  deployment would need a DB-level lock (e.g. `select ... for update` on
  the `image_sessions` row), which isn't build-able without a schema change
  the brief didn't ask for (crmex.md's schema has no version/lock column).
  Fine for a single-instance deployment; flag this if/when core-server is
  scaled horizontally.
- `src/jobs/retention.ts` — the retention job's testable core (crmex.md
  §13.6); `src/jobs/retentionCli.ts` is the thin CLI wrapper. A session's
  current image counts as "sent" if some `message_history` row's
  `media_path` matches it (age measured from that message's `created_at`);
  otherwise it's "unsent" (age measured from the session's `updated_at`).
  Deleting an object never deletes its `message_history` row (RET-05).
- `src/api/admin.ts` — deliberately a bare skeleton (crmex.md §13: the
  admin portal is design-only this phase). One route (`GET
  /api/v1/admin/_ping`) exists solely so the role gate
  (`src/auth/adminMiddleware.ts`) has something to protect and can be
  exercised end-to-end (ROLE-01..05). No settings CRUD, no retention
  trigger, no system-health query — those are portal features for later.

## Ambiguities resolved (and how)

The build brief flagged a few points as intentionally left to judgment.
Choices made, all toward the more conservative/secure reading of §4:

- **Admin route scope.** The brief says both "do NOT build any admin route
  beyond a stub that 403s everyone" and requires ROLE-03 ("Admin account
  calls an admin route -> Permitted") to pass. Read literally, "403s
  everyone" can't be true and ROLE-03 can't pass at the same time. Resolved
  as: the admin route exists only to exercise the role gate itself (a
  `_ping` that requires admin and returns `{ok:true}`) — no actual admin
  *functionality* (no settings mutation, no data access) is built, which is
  what "no admin route beyond a bare skeleton" is protecting against.
- **`buildObjectPath`'s user-id validation.** crmex.md doesn't specify a
  literal format check beyond "JWT-derived". Real Supabase user ids are
  UUIDs; the validator here accepts any string matching
  `^[A-Za-z0-9_-]{1,128}$` rather than a strict UUID regex, so it stays
  testable with readable fixture ids (`'user-a'`) without weakening what
  ISO-19 actually cares about: no `/`, `.`, or whitespace can reach a path
  segment.
- **IMG-10 concurrency.** "Serialized or the later rejected" — implemented
  as serialized (both refinements succeed, in submission order) rather than
  rejecting the second, since that's the better UX and the brief accepts
  either. See the session-lock limitation above.
- **Refine quota.** The API contract shows a 429 shape for
  `POST /images/:sessionId/refine`, so refinement is charged against the
  same daily-image-generation quota as `generate` (there's no separate
  "refinement quota" setting in crmex.md §13.3).
- **`search/select` quota.** The contract doesn't show a 429 for this
  route, so it isn't quota-gated the way generate/refine are — it still
  never trusts a client-supplied path (downloads bytes server-side, derives
  the path from their hash).

## Manual setup checklist — what remains before this can go live

Everything below is real work a human needs to do; none of it can be
scripted from inside this repo without credentials.

1. **Create a Supabase project** (https://supabase.com/dashboard) if one
   doesn't exist yet for this app.
2. **Run the migrations** in `../supabase/migrations/` against it:
   - Easiest: `npx supabase login`, `npx supabase link --project-ref <ref>`,
     then `npx supabase db push` from the repo root.
   - Or paste each file's contents into the SQL editor in the dashboard, in
     filename order (they're already timestamp-ordered).
   - **These have not been run or verified against a real instance from
     this environment** — Docker wasn't running here, so `supabase start`
     (a local instance) wasn't available either. Treat the SQL as reviewed
     and spec-accurate, not as tested.
3. **Verify the storage bucket.** After migrating, confirm in
   Storage → Buckets that `user-images` exists and is marked **private**,
   and check Storage → Policies that the three `own_images_*` policies are
   attached to `storage.objects`.
4. **Grab the service role key** — Project Settings → API → Project API
   keys → `service_role`. This is a secret with full DB/Storage access
   (bypasses RLS). Put it in `SUPABASE_SERVICE_ROLE_KEY`. Never ship it to
   the Android app or any client.
5. **Set `SUPABASE_URL`** — same API settings page.
6. **Get provider keys** for whichever adapters you're turning on:
   - Anthropic: https://console.anthropic.com/settings/keys →
     `ANTHROPIC_API_KEY`.
   - OpenAI: https://platform.openai.com/api-keys → `OPENAI_API_KEY`.
     Verify the account has access to `gpt-image-1` (or change
     `DEFAULT_MODEL` in `src/providers/image-gen/openai.ts` to whatever
     image model the account is actually provisioned for).
   - Unsplash: https://unsplash.com/oauth/applications → create an app →
     Access Key → `UNSPLASH_ACCESS_KEY`. Unsplash's free tier has a low
     request-per-hour demo limit; apply for production access before
     shipping.
7. **Seed `app_settings`** — the third migration
   (`20250101000200_admin_schema.sql`) already seeds sensible defaults
   (`quota.default_daily_images=50`, `retention.sent_image_ttl_days=30`,
   etc. — see the migration file for the full list and rationale). Revisit
   these numbers for your actual expected usage/cost before going live;
   they're defaults, not researched limits.
8. **Set up Google OAuth in Supabase Auth** (Authentication → Providers →
   Google) — required for the Android app's sign-in flow (crmex.md §5).
   This repo only verifies whatever token Supabase Auth issues; it doesn't
   configure the OAuth provider itself.
9. **Set `app_metadata.role = 'admin'`** on whichever account(s) should
   have admin access, out of band (there's no self-service path, by design
   — crmex.md §13.1). E.g. via the Supabase dashboard's user editor, or
   `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })`
   from a trusted script using the service role key.
10. **Schedule the retention job.** `npm run retention` needs to run
    periodically (daily is reasonable given the seeded TTLs are in days) —
    wire it into cron, a Supabase scheduled Edge Function, or your
    deployment platform's job scheduler. Nothing runs it automatically.
11. **Re-run the ISO-01..11 scenarios against the real project** once it
    exists, using real `@supabase/supabase-js` clients authenticated as two
    real test accounts, instead of `test/fakes/fakeSupabaseClient.ts`. The
    fake is a faithful re-implementation of the RLS/Storage policies as
    written, but it is still a re-implementation — the only real proof that
    Postgres and Storage enforce them as intended is running against
    Postgres and Storage.
12. **Deploy `core-server` itself** somewhere that can hold secrets (not a
    static host, not a client-side bundle) — e.g. a small container/VM/
    Cloud Run/Fly.io app — with the `.env` values above set as real
    environment configuration, and point the Android app's API base URL at
    it.
