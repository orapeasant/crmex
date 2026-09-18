# CRMEX

A multi-tenant CRM and WhatsApp outreach app for law firms. A firm's members share
its clients, matters, tasks and message history; nothing crosses between firms.

The core flow: describe or generate an image with AI, describe in natural language
which clients to reach ("clients in Cairo who haven't replied this month"), review
the matched recipients, and send over WhatsApp through an embedded Baileys sender
that paces delivery.

Android is the primary client; a browser client (`web-ui`) runs the same shared app
and hands sends off to the user's paired phone.

## Architecture

Three tiers, each with a strict boundary (see `docs/spec/crmex.md`):

| Tier | Holds | Never holds |
| :--- | :--- | :--- |
| **Client** (Capacitor WebView, `shared-ui`) | Local SQLite (`outbox`, `image_cache`), image cache, contacts access, the Supabase session JWT | AI provider keys |
| **Embedded Node** (`nodejs-mobile`, Android only) | The Baileys WhatsApp socket and the send-pacing loop | A database, an HTTP server — it talks over the `capacitor-nodejs` IPC bridge |
| **`core-server`** (cloud, Express) | The AI provider keys, the LLM / image-gen / image-search adapters, quota and retention enforcement | Anything it can let the client do directly against Supabase under RLS |

Supabase is authoritative for everything a user or firm owns — auth, CRM tables,
`message_history`, `image_sessions`, and the image files themselves (private bucket,
objects at `<org_id>/<user_id>/<sha256>.png`). The device holds caches only.

Rules that are easy to get wrong:

- `core-server` uses the **service role key, which bypasses RLS and Storage policies**.
  It derives `user_id` from the verified JWT and builds every query and object path
  itself — a client-supplied `user_id` or path fragment is never trusted.
- `X-Org-Id` is verified against `org_members` on every firm-scoped request. The header
  *selects* a firm; it never grants access. Firm roles live on `org_members`, not in
  `user_metadata`.
- Platform roles come from Supabase `app_metadata.role` — `user_metadata` is writable by
  the session's own user, so a role stored there would be self-assignable.
- Image downloads use short-TTL signed URLs. They are bearer credentials: don't log or
  persist them.

## Layout

```
core-server/   Express API (/api/v1) — images, contact matching, message drafting, orgs, admin
shared-ui/     React app + business logic shared by Android and browser (no platform APIs)
web-ui/        Vite browser shell (OAuth redirect sign-in, localStorage, invite links)
android/       Capacitor shell + the nodejs-mobile payload (Baileys) under nodejs-assets/
supabase/      SQL migrations: core schema, storage bucket, admin, multi-tenancy, CRM, send jobs
docs/spec/     crmex.md (architecture) and test-plan.md (test cases with stable IDs)
PLAN.md        Build plan: locked decisions, scope, build order — read this first

pnpm-workspace.yaml   Workspace members: core-server, shared-ui, web-ui (android is not one)
package.json          Root scripts — dev / build / typecheck / test across the workspace
```

## Prerequisites

- Node.js >= 20
- pnpm 10 (`corepack enable && corepack prepare pnpm@10.15.0 --activate`)
- A Supabase project with `supabase/migrations/` applied
- Android Studio + JDK for the Android shell (target device: arm64-v8a, API 29+)
- Provider keys for whichever AI providers you enable (Anthropic / OpenAI / Unsplash)

## Setup

`core-server`, `shared-ui` and `web-ui` are one **pnpm workspace**, installed and run
from the repo root. The Android shell is deliberately *not* a workspace member —
Capacitor's CLI and Gradle resolve plugins from a flat `node_modules`, which pnpm's
symlinked layout breaks — so it keeps its own npm install.

```bash
# from the repo root — installs core-server, shared-ui and web-ui
pnpm install

cp core-server/.env.example core-server/.env   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, provider keys
cp web-ui/.env.example web-ui/.env             # VITE_SUPABASE_ANON_KEY must be the anon key, never service role

pnpm dev        # core-server on :8080 and web-ui on :5173, together
```

`pnpm dev` runs both in parallel and is the normal way to work on the cloud + browser
pair. `pnpm dev:server` and `pnpm dev:web` run one side alone. Vite uses `strictPort`,
so a stale process on 5173 fails the whole `pnpm dev` group rather than silently
moving ports.

Providers default to `fake` when unset, so `core-server` boots and serves
`/api/v1/health` with no keys configured; other routes then fail with a clear provider
error rather than a stack trace. Missing Supabase credentials fail fast at boot by name.

The Android shell installs separately, with npm:

```bash
cd android && npm install
# create android/.env with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_CORE_SERVER_URL
npm run build && npm run sync && npm run installDebug
```

## Commands

From the repo root (each runs across the workspace):

| Command | Does |
| :--- | :--- |
| `pnpm dev` | `core-server` (:8080) and `web-ui` (:5173) in parallel |
| `pnpm dev:server` / `pnpm dev:web` | one side alone |
| `pnpm build` | builds `core-server` then `web-ui` |
| `pnpm typecheck` | all three packages |
| `pnpm test` | `core-server` (162 cases) and `shared-ui` (113) |

Per package, run from that package's own directory (`android` uses npm, the rest pnpm):

| | `core-server` | `shared-ui` | `web-ui` | `android` (npm) |
| :--- | :--- | :--- | :--- | :--- |
| build | `pnpm build` | — | `pnpm build` | `npm run build` |
| typecheck | `pnpm typecheck` | `pnpm typecheck` | `pnpm typecheck` | `npm run build` |
| test | `pnpm test` | `pnpm test` | — | — |
| dev | `pnpm dev` (:8080) | — | `pnpm dev` | `npm run dev` |

Or target one from the root without changing directory:
`pnpm --filter core-server test`, `pnpm --filter crmex-web build`.

There is no linter; typecheck is the gate.

## Testing

`pnpm test` in `core-server` is offline and credential-free — keep it that way. It uses
a fake Supabase client that models RLS and Storage policies.

```bash
pnpm --filter core-server test                        # offline suite
LIVE_SUPABASE=1 pnpm --filter core-server test:live   # against the real Supabase project
```

`test:live` exercises real RLS, real Storage policies and real JWTs with accounts and
firms it creates and tears down per run. **When you change a migration or
`test/fakes/fakeSupabaseClient.ts`, run both** — the fake only proves the policies were
modelled correctly, never that Postgres enforces them.

Test cases have stable IDs (`ISO-07`, `SEND-06`, `TEN-22`, …) in `docs/spec/test-plan.md`;
reference the ID when implementing or discussing a case. The isolation suite needs two
test accounts — a single-account run cannot detect an isolation failure.

Retention (deletes expired objects and rows; nothing in the repo schedules it):

```bash
pnpm --filter core-server retention -- --dry-run
pnpm --filter core-server retention
```

## Status

Steps 0–15 of the build order in `PLAN.md` are implemented, with the multi-tenancy
migrations applied to a real Supabase project. The admin portal (`crmex.md` §13) is
designed but **not** implemented — it is web-only, never compiled into the APK or the
Electron shell, and it cannot observe users at all: no content, no per-user activity,
no account listing, no break-glass. The quota, batch-size and retention checks it would
configure are not optional and already live in `core-server`, reading seeded defaults
from `app_settings`.

## Notes

- WhatsApp sending uses Baileys, an unofficial protocol implementation. Treat send
  pacing as ordinary rate limiting for a batch job — not as a way to defeat platform
  abuse detection.
- The test device is a Huawei P30 Pro (Android 10 / API 29). EMUI's battery manager
  kills background processes aggressively; whitelist the app manually when testing
  background sends.
