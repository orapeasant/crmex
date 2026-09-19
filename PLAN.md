# PLAN.md — CRMEX Build Plan

Working plan derived from `docs/spec/crmex.md`. **This file covers `core-server`, `shared-ui`, `web-ui` and `supabase/` only; everything specific to the Android app is in `ANDROID_PLAN.md`.** This is the source of truth for **what to build and in what order**; `crmex.md` is the architecture reference and `docs/spec/test-plan.md` is the test specification.

---

## 1. Product summary

A multi-tenant CRM for law firms with WhatsApp outreach, delivered as an Android app (the only WhatsApp sender — see `ANDROID_PLAN.md`) and a browser client over one shared UI and one cloud backend. It lets a user:
1. Describe or search for an image using natural language, refine it through an AI chat-style loop. (Saving to the phone's photo library is Android — `ANDROID_PLAN.md`.)
2. Describe, in natural language, which clients to target (e.g. "customers in Cairo who haven't replied this month").
3. Send the resulting image (or text) to the matched clients over WhatsApp. This plan queues and records the send; the paced sending itself is done by the user's Android app (`ANDROID_PLAN.md`).

## 2. Architecture decisions locked so far

- **Supabase is authoritative for everything a user owns**: Google OAuth via Supabase Auth; `message_history`, `image_sessions` and `contact_meta` in Postgres with RLS; image files in a **private** Storage bucket at `<user_id>/<sha256>.png` with folder-prefix policies. `core-server` uses the service role key (which bypasses both RLS and Storage policies) so it must filter queries and construct object paths from the JWT-derived `user_id` itself.
- **Images are generated server-side, stored in Supabase, cached on the phone**: the device cache is evictable (`Directory.Cache`), partitioned per `user_id`, and purged on sign-out. Every client, browser included, can re-render full image history.
- **Strict per-user isolation** is a hard requirement, not a nice-to-have: no user may see another's images or messages. Enforced at bucket policy, RLS, server-side path construction, and the local cache partition.
- **Multi-tenant SaaS for law firms (decided 2026-09-13, `crmex.md` §15).** The firm is the tenant: members share the firm's clients, matters, tasks and send history; nothing crosses firms. Firm roles (`owner`/`admin`/`member`) live on `org_members`, never `user_metadata`. Enforced by RLS membership helpers, by `core-server` verifying `X-Org-Id` against the database, and by `<org_id>/<user_id>/<sha256>.png` storage paths. WhatsApp pairing and device caches stay per user.
- **Android is the only WhatsApp sender.** Its architecture — embedded Node/Baileys, the IPC bridge (no local HTTP server), local SQLite, device caches — is in `ANDROID_PLAN.md` §1 and §12. Everything here treats sending as a queued `send_jobs` row that the sender's phone executes.
- **Clients are CRM records in Supabase** (not just phone-contact metadata), importable from the phone's address book (Android — `ANDROID_PLAN.md`).
- **Provider-agnostic adapters**: LLM, image-generation, and image-search are each behind a narrow interface (`LlmProvider`, `ImageGenProvider`, `ImageSearchProvider`) so the concrete vendor is a config choice. No vendor chosen yet — needs API keys/accounts before implementation.
- **Reusability seam**: business logic and UI components avoid platform-only APIs — native capabilities (photo library save, Google sign-in token acquisition) go through an injected `NativeBridge` interface, so a `shared-ui` layer can later be dropped into a browser or Electron shell without rework.

## 3. Feature scope (this phase)

- Google login (Supabase Auth), single-user session on-device.
- Natural-language matching of clients (server-side `contactMatcher`). Reading the phone's address book is Android work (`ANDROID_PLAN.md`).
- Image generation via a configurable AI image provider.
- Image search (find existing images) via a configurable provider.
- Iterative refine loop: user gives follow-up instructions, image regenerates/edits, history kept per session.
- Select clients (from NL match results) and queue a send: the queue (`send_jobs`), history and the browser hand-off are here; the WhatsApp sending itself is Android-only (`ANDROID_PLAN.md`).
- Send queue (`send_jobs`) and image session history persisted in Supabase (source of truth).

**CRM phase (added 2026-09-13)** — app shell with a bottom navigation bar and four sections:
- **Clients** — list/search/filter by kind and tag, detail page (contact info, notes, opt-out flag (controls all messaging), linked matters, message history), create/edit, import from phone contacts.
- **Matters** — list by status, detail (number, title, practice area, dates, notes, linked clients, tasks), create/edit.
- **Tasks** — tasks, deadlines and hearings with due dates, optionally linked to a matter and assigned to a member; overdue/today/upcoming grouping.
- **Messages** — the existing Compose → Contacts → Review wizard (recipients picked from firm clients) plus sent-batch history.
- Firm onboarding (create firm / accept invitation), member invitations and roles, firm switcher.

**Explicitly out of scope for this phase** (candidates for a later plan revision): the admin portal (designed in `crmex.md` §13 but not implemented), SaaS billing/payments (Billing page stays informational), delivery/read-receipt tracking, message templates, multi-channel (SMS/email) support, document storage, time tracking/invoicing, calendar sync, push reminders, iOS.

Note that the admin portal being out of scope does **not** make quota and retention enforcement out of scope. Enforcement lives in `core-server` and must ship with the features it governs, reading seeded defaults from `app_settings`. The portal only changes those values later.

## 4. Build order

1. **Scaffold** — Supabase project with `message_history`/`image_sessions`/`contact_meta` + RLS policies, and the private `user-images` Storage bucket + folder-prefix policies. *(Capacitor project, Node payload skeleton and local SQLite: `ANDROID_PLAN.md`.)*
2. **Auth** — Supabase Google provider; gate the app behind a session; `core-server` JWT middleware. *(Native Google Sign-In on Android: `ANDROID_PLAN.md`.)*
4. **NL matching** — `contactMatcher` on `core-server`; E.164 normalization with `libphonenumber-js` and a `needsReview` bucket in `shared-ui`. *(Reading the address book, SIM region, the `onWhatsApp()` check: `ANDROID_PLAN.md`.)*
5. **Image generation/search + refine loop** — provider adapters on `core-server`, upload to the private bucket with server-constructed paths, signed-URL download, `image_sessions`, refine UI. The isolation suite (`test-plan.md` §2) must pass before this step is considered done. *(The per-user device cache and eviction: `ANDROID_PLAN.md`.)*
7. **Wire the end-to-end flow** — contact match → image create/refine → save (optional) → confirm batch size → send.
8. **Hardening (server side)** — provider failures and image generation cost caps. *(Reconnect/offline states, the duplicate-send prompt, foreground-service lifecycle and the Huawei whitelist: `ANDROID_PLAN.md`.)*

Steps 1–7 are done on the server and shared side. **Android-specific work — steps 0, 3 and 6, and the Android halves of 1, 2, 4, 5, 8 and 11 — lives in `ANDROID_PLAN.md`.** Step numbers are kept here so existing references stay valid. The CRM phase continues:

9. **Tenancy foundation** — migration: `organizations`, `org_members`, `org_invitations`, `is_org_member`/`has_org_role` helpers, `org_id` on `message_history`/`image_sessions`/`usage_daily`, org-prefixed storage policies, backfill a personal firm for existing users. `core-server`: org-membership middleware (`X-Org-Id`), org-scoped repositories and paths, `POST /orgs`, invitations. Firm-axis isolation tests (§15.9) must pass before step 10. **Done, and verified live (2026-09-14):** the migrations are applied to the real Supabase project and `core-server/test/live` (`npm run test:live`, 43 cases) re-runs TEN-02..27, TEN-30..33 and ISO-07 against it with four real accounts and two firms — real RLS, real Storage policies, real JWTs. Still outstanding there: TEN-01 (catalog audit), TEN-19 (backfill), TEN-22 (account deletion), TEN-26/28/29 (Realtime) and the device cases.
10. **App shell** — bottom navigation (Clients · Matters · Tasks · Messages), firm onboarding screen, firm switcher, members & invitations under Settings.
11. **Clients** — `clients` table + RLS, list/detail/edit, phone-contact import with E.164 normalization and dedupe, consent/suppression; the send wizard picks recipients from firm clients. *(The phone-contact import screen: `ANDROID_PLAN.md`.)*
12. **Matters** — `matters`, `matter_clients`, list/detail/edit, link clients.
13. **Tasks** — `tasks`, grouped list, create/edit/complete, link to matter and assignee.
14. **Browser client (§15.10)** — `web-ui` Vite shell mounting the shared app from `shared-ui` with a browser platform implementation (OAuth redirect sign-in, localStorage, invite links). Sending from the browser queues a `send_jobs` row that the user's own phone claims atomically and sends. Local dev only for now.
15. **Message history** — per-batch history screen; client detail shows messages sent to that client.
16. **Campaigns (§18)** — data layer, upload endpoint and wizard **done 2026-09-19** (migration written, not yet applied). Remaining: `device_presence` (§18.6), the under-20 stagger and same-day overlap warning (§18.5/§18.7).
17. **§16 stage 1 (§16, decided 2026-09-19)** — `events`, `event_reminders` and the dispatcher tick; the server-side campaign dispatcher (§18.6) rides on the same tick.
18. **Occasion rules (§19, after approval, needs step 17)** — `occasion_rules` / `client_dates` / `occasion_occurrences`, the hourly scanner with its idempotent insert and stagger, and the rule UI under Settings.
19. **Firm numbering (§20, after approval)** — `org_number_formats`, `clients.client_number`, the `BEFORE INSERT` allocator on `matters`/`clients` (gapless, per-firm unique), owner-only Settings → Firm → Numbering with live preview; the number fields leave the matter/client forms; related matters get sub-numbers (§20.10).
20. **AI assistant (§22, after approval; needs §20 (step 19) and gyrfalcon G4/G7)** — `AgentEngine` adapter + fake; `org_agent_settings` / `user_agent_prefs` / `agent_runs` / `agent_proposals` / `agent_actions`; kill switches and `/assistant/status`; read tools and the plan executor (per-action Ask/Auto, outbound cap, ambiguity → Ask, Undo); SSE + Realtime; the Agent setup screens; background runs and the inbox. Browser voice via the Web Speech API in `web-ui` (§21.3). *(The assistant sheet, voice and entry points on Android: `ANDROID_PLAN.md`.)*
21. **Messaging composer, drafts and batch cancel (§23, after approval)** — `message_drafts` + versions; the Schedule stop in the shared composer; `send_jobs.cancel_requested_at` / `cancelled_by`, the amended guard and `cancel_send_job`; `CANCELLED` values; batch search and detail in both shells. *(The phone's stop-before-next-send path: `ANDROID_PLAN.md`.)*

## 5. Decisions still needed before/during implementation

- Which concrete LLM, image-generation, and image-search providers to use first (accounts/API keys).
- Starting values for the quota, retention and pacing settings (`crmex.md` §13.3). The admin portal is designed but not being built, so these need sensible seeded defaults shipped alongside the enforcement code.
- How much contact metadata is safe to send to an external LLM for NL matching vs. handled by a local heuristic first. *(Superseded in part by §22.5: the model sees what its read tools return, within the owner's read-scope toggles.)*
- **Scheduling, processes and reminders** (`crmex.md` §16, designed 2026-09-17): **decided 2026-09-19 to build in stages** (step 17) — `events` + `event_reminders` + the dispatcher tick first, with templates, `apply_process`, the move functions and the overdue sweep deferred. **D1–D8 in §16.13 are still open and gate stage 1.** Remove "push reminders" from the §3 out-of-scope list when stage 1 lands.
- ~~**Scheduled bulk send / campaigns**~~ (`crmex.md` §18) — **all decisions closed 2026-09-19 (C-D1..C-D6); built, apart from the phone-side items in `ANDROID_PLAN.md` §4.3.** Removed from the §3 out-of-scope list. Added `clients.status` (`active`/`inactive`/`archived` — a CRM lifecycle flag kept separate from the `suppressed_at` opt-out) and extended `send_jobs` with `scheduled_at` / `interval_ms` / `jitter_pct` / `expires_at`. The sender's phone remains the only sender; the schedule moves server-side with §16's dispatcher, and FCM wake-up stays deferred to §18.9. **Outstanding: the migration has not been applied to the Supabase project**, and `device_presence` (§18.6), the under-20 stagger and the same-day overlap warning are not built.
- **`crmex.md` §16 — scheduling, in stages (decided 2026-09-19).** §19 needs it and it is the bigger build, so it lands in stages: first `events` + `event_reminders` + the dispatcher tick (the minimum §19 and the §18 server-side dispatcher both need), then §19's occasion rules, with process templates, `apply_process`, `preview_move`/`apply_move` and the overdue sweep deferred to a later stage. Resolve §16.13 D1–D8 before stage 1.
- **Occasion rules** (`crmex.md` §19, designed 2026-09-18, under review): firm-wide recurring client notifications (birthdays, anniversaries, custom dates). Resolve O-D1–O-D5 in §19.7, then add its build steps (§19.8) to §4. Promotes the item deferred in §16.11, so it lands with or after §16 — it materializes `events`/`event_reminders` and adds no delivery path of its own.
- **Firm numbering — the number wheel** (`crmex.md` §20, designed 2026-09-19, under review): N-D1..N-D5 decided 2026-09-19 (§20.8; sub-numbering designed in §20.10). Matters and clients get database-assigned, per-firm-unique numbers; the owner defines the pattern; existing numbers never change.
- **AI assistant** (`crmex.md` §22, designed 2026-09-19, under review): AG-D1..AG-D9 decided 2026-09-19 (§22.14): default matrix all-Ask except drafts; ceilings 100 outbound / 50 turns / 10 steps; inbox only (no push); model allow-list in `app_settings`. Gyrfalcon is the only agent engine; `core-server` runs the plan executor and is the only writer. Per-action Ask/Auto set by the owner (everything Auto-able, outbound capped at 50/firm/day by default), no deletes, Undo for 24 h, **new firms start with AI on** (owner can turn it off; one-time notice of what is sent to the provider). Narrows §17.2 rule 3.
- **Messaging composer, drafts, schedule and batch cancel** (`crmex.md` §23, designed 2026-09-19, under review): MSG-D1..MSG-D7 decided 2026-09-19 (§23.6); drafts use a leased edit lock. Server-side `message_drafts`; a Schedule stop; cancel = stop everything unsent, by the creator or an owner/admin; drafts readable by the creator and the owner only; a dead phone's cancel request is closed out after 30 min. Supersedes §18.6.
- **Agentic engine — gyrfalcon** (`crmex.md` §17, designed 2026-09-17, under review): resolve G-D1..G-D7 in §17.10; gyrfalcon-side changes G1–G6 (§17.9) gate production use. **Amended by §22:** read tools are now required and G7 (per-run model, prompt and structured output) is added.
- **Decided 2026-09-17:** consent is **opt-out**. The client-level "Opted out" flag (`clients.suppressed_at`) controls every message, manual or scheduled; `opted_in_at` is informational and never gates sending (`crmex.md` §12).
- **Decided 2026-09-13:** invitations go by **email or QR code** (the app shows a QR code and a share/email link; email opens the device mail composer until server-side email is configured). Existing test data moves into a **"Demo Firm"**. The **operator (platform admin) sees firms and their users** — firm name, plan, members' names/emails/roles — **but never firm data** (clients, matters, tasks, messages, images, per-member activity).

---

*Update this file as decisions are made or scope changes — it should stay a short, current punch list, not a history log.*
