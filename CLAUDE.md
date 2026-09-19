# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Steps 0–15 of the build order are implemented. `core-server`, `shared-ui`, `web-ui`, the Android shell and the Supabase migrations all exist, and the migrations are applied to a real Supabase project.

Documents:

- `PLAN.md` — **read this first.** Current build plan: locked architecture decisions, feature scope, and build order. This is the source of truth for what to build next; keep it updated as scope or decisions change.
- `docs/spec/crmex.md` — the consolidated architecture specification (storage model, auth, AI provider layer, contacts/E.164, image flow, WhatsApp delivery, Android platform requirements, admin portal). Earlier split specs have been retired into this file.
- `docs/spec/test-plan.md` — test cases derived from the spec, with stable IDs (`ISO-07`, `SEND-06`, …). Reference the ID when implementing or discussing a case. Two test accounts (User A / User B) are required for the isolation suite — a single-account suite cannot detect an isolation failure.

Commands — `core-server`, `shared-ui` and `web-ui` are one **pnpm workspace**; run them
from the repo root. `android` is not a workspace member (Capacitor/Gradle need a flat
`node_modules`) and keeps its own npm install.

| Root command | Does |
| :--- | :--- |
| `pnpm install` | installs core-server, shared-ui, web-ui |
| `pnpm dev` | core-server (:8080) + web-ui (:5173) in parallel |
| `pnpm dev:server` / `pnpm dev:web` | one side alone |
| `pnpm build` | core-server, then web-ui |
| `pnpm typecheck` | all three packages |
| `pnpm test` | core-server + shared-ui |

Target one package without changing directory: `pnpm --filter core-server test`,
`pnpm --filter crmex-web build`. Inside `android/`: `npm run build`, `npm run sync`,
`npm run installDebug`.

There is no linter configured; typecheck is the gate.

`core-server` additionally has `pnpm --filter core-server test:live` (requires `LIVE_SUPABASE=1`), which runs `test/live/` against the real Supabase project — real RLS, real Storage policies, real JWTs, with accounts and firms it creates and tears down per run. `pnpm test` stays offline and credential-free; keep it that way. When you change a migration or `test/fakes/fakeSupabaseClient.ts`, run both — the fake only proves the policies were modelled correctly, never that Postgres enforces them.

## Intended architecture (per `docs/spec/crmex.md`)

Three tiers, each with a strict boundary:

- **Client** — Capacitor WebView (Android; browser/Electron later) rendering `shared-ui`. Owns local SQLite (`outbox`, `image_sessions`) via `@capacitor-community/sqlite`, the local image store, contacts access, and the Supabase session JWT. Never holds AI provider keys.
- **Embedded Node** (`nodejs-mobile`, Android only) — holds the Baileys WhatsApp socket and the send-pacing loop, nothing else. No database, **no HTTP server** (communication is over the `capacitor-nodejs` IPC bridge).
- **`core-server`** (cloud) — the only holder of AI provider API keys. Runs the LLM / image-gen / image-search adapters and verifies the Supabase JWT on every request.

Storage rules that are easy to get wrong:
- **Supabase is authoritative for everything a user owns** — auth, `message_history`, `image_sessions`, `contact_meta` (Postgres, `user_id`-scoped with RLS) and the image files themselves (Storage, private bucket, objects at `<user_id>/<sha256>.png` with folder-prefix policies).
- **The device holds only caches.** Local SQLite is durability and cache-index only: `outbox` buffers a batch so it survives an app kill, `image_cache` tracks what's downloaded. Neither is a source of truth. The image cache lives in `Directory.Cache`, partitioned per `user_id`, and is purged on sign-out.
- `core-server` uses the Supabase **service role key, which bypasses RLS and Storage policies**, so it must derive `user_id` from the verified JWT and filter every query and construct every object path itself. Never trust a client-supplied `user_id` or path fragment.
- Image downloads use **short-TTL signed URLs**, which are bearer credentials — don't log or persist them.
- No user may ever see another user's images or messages; §4 of the spec is the checklist for this. **CRMEX is becoming a multi-tenant SaaS for law firms (spec §15):** for CRM data the boundary is the firm — members of a firm share its clients/matters/tasks/history, and nothing may cross between firms. `core-server` must verify the `X-Org-Id` header against `org_members` in the database on every firm-scoped request; the header selects a firm, it never grants access. Firm roles live on `org_members`, not in `user_metadata`. §13.2 goes further for operators: the admin portal configures the system and cannot observe users at all — no content, no per-user activity or counts, no account listing, and no break-glass flow. `usage_daily` exists only so `core-server` can enforce quotas; never expose a per-user read of it through an admin route.
- Roles come from Supabase `app_metadata.role`, never `user_metadata` — the latter is writable by the user who owns the session, so a role stored there is self-assignable.
- The admin portal (§13) is designed but **not** being implemented. It is web-only — a separate build and host, never compiled into the Android APK or the Electron shell, and it shares no code with `shared-ui`. Its enforcement points are not optional though: quota, batch-size and retention checks live in `core-server` and ship with the features they govern, reading seeded defaults from `app_settings`.

## Working with this repo right now

- Sending WhatsApp messages via Baileys uses an unofficial, unauthenticated-by-Meta protocol implementation. Treat send pacing as ordinary rate limiting for a batch job, not as a mechanism for defeating platform abuse detection — the original spec used the latter framing and it should not guide implementation choices.
- The connected test device is a Huawei P30 Pro (Android 10 / API 29, arm64-v8a). Huawei's EMUI battery manager kills background processes aggressively; expect to whitelist the app manually when testing background sends.
