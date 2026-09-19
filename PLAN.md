# PLAN.md — CRMEX Build Plan

Working plan derived from `docs/spec/crmex.md`. This is the source of truth for **what to build and in what order**; `crmex.md` is the architecture reference and `docs/spec/test-plan.md` is the test specification.

---

## 1. Product summary

An Android app (reusable later on web/Electron) that lets a user:
1. Describe or search for an image using natural language, refine it through an AI chat-style loop, and optionally save it to the phone's photo library.
2. Describe, in natural language, which contacts to target (e.g. "customers in Cairo who haven't replied this month").
3. Send the resulting image (or text) to the matched contacts over WhatsApp, via an embedded Baileys-based sender that paces sends to avoid tripping WhatsApp's abuse detection.

## 2. Architecture decisions locked so far

- **Android-first**: all core logic (LLM calls, image gen/search, contact matching, WhatsApp queue) lives in the Android app's embedded Node background engine. Web/Electron are future thin reuse targets via a shared UI layer — not built in this pass.
- **Supabase is authoritative for everything a user owns**: Google OAuth via Supabase Auth; `message_history`, `image_sessions` and `contact_meta` in Postgres with RLS; image files in a **private** Storage bucket at `<user_id>/<sha256>.png` with folder-prefix policies. `core-server` uses the service role key (which bypasses both RLS and Storage policies) so it must filter queries and construct object paths from the JWT-derived `user_id` itself.
- **Images are generated server-side, stored in Supabase, cached on the phone**: the device cache is evictable (`Directory.Cache`), partitioned per `user_id`, and purged on sign-out. Every client, browser included, can re-render full image history.
- **Local SQLite is durability and cache-index only**, not a source of truth: `outbox` so a batch survives an app kill, `image_cache` to track downloads. The WhatsApp `useMultiFileAuthState` folder is also device-local — a session is cryptographically bound to one device pairing.
- **Strict per-user isolation** is a hard requirement, not a nice-to-have: no user may see another's images or messages. Enforced at bucket policy, RLS, server-side path construction, and the local cache partition.
- **Multi-tenant SaaS for law firms (decided 2026-09-13, `crmex.md` §15).** The firm is the tenant: members share the firm's clients, matters, tasks and send history; nothing crosses firms. Firm roles (`owner`/`admin`/`member`) live on `org_members`, never `user_metadata`. Enforced by RLS membership helpers, by `core-server` verifying `X-Org-Id` against the database, and by `<org_id>/<user_id>/<sha256>.png` storage paths. WhatsApp pairing and device caches stay per user.
- **Clients are CRM records in Supabase** (not just phone-contact metadata), importable from the phone's address book.
- **Embedded Node does Baileys and nothing else**: no `sqlite3` (removes the native-module build risk), and **no local HTTP server** — the old localhost Express design bound to `0.0.0.0` and was reachable by anyone on the same Wi-Fi. Replaced by the `capacitor-nodejs` IPC bridge, which has no listening port.
- **Provider-agnostic adapters**: LLM, image-generation, and image-search are each behind a narrow interface (`LlmProvider`, `ImageGenProvider`, `ImageSearchProvider`) so the concrete vendor is a config choice. No vendor chosen yet — needs API keys/accounts before implementation.
- **Reusability seam**: business logic and UI components avoid platform-only APIs — native capabilities (photo library save, Google sign-in token acquisition) go through an injected `NativeBridge` interface, so a `shared-ui` layer can later be dropped into a browser or Electron shell without rework.

## 3. Feature scope (this phase)

- Google login (Supabase Auth), single-user session on-device.
- Natural-language contact search over the phone's local address book (read via `@capacitor-community/contacts` or equivalent).
- Image generation via a configurable AI image provider.
- Image search (find existing images) via a configurable provider.
- Iterative refine loop: user gives follow-up instructions, image regenerates/edits, history kept per session.
- Save current image to the device photo library.
- Select contacts (from NL match results) + send image/text via the embedded Baileys WhatsApp engine, with paced/sequential delivery.
- Send queue and image session history persisted in Supabase (source of truth); a local SQLite outbox absorbs sends mid-flight so the app survives being backgrounded/restarted or losing connectivity.

**CRM phase (added 2026-09-13)** — app shell with a bottom navigation bar and four sections:
- **Clients** — list/search/filter by kind and tag, detail page (contact info, notes, opt-out flag (controls all messaging), linked matters, message history), create/edit, import from phone contacts.
- **Matters** — list by status, detail (number, title, practice area, dates, notes, linked clients, tasks), create/edit.
- **Tasks** — tasks, deadlines and hearings with due dates, optionally linked to a matter and assigned to a member; overdue/today/upcoming grouping.
- **Messages** — the existing Compose → Contacts → Review wizard (recipients picked from firm clients) plus sent-batch history.
- Firm onboarding (create firm / accept invitation), member invitations and roles, firm switcher.

**Explicitly out of scope for this phase** (candidates for a later plan revision): the admin portal (designed in `crmex.md` §13 but not implemented), SaaS billing/payments (Billing page stays informational), campaign scheduling, delivery/read-receipt tracking, message templates, multi-channel (SMS/email) support, document storage, time tracking/invoicing, calendar sync, push reminders, iOS.

Note that the admin portal being out of scope does **not** make quota and retention enforcement out of scope. Enforcement lives in `core-server` and must ship with the features it governs, reading seeded defaults from `app_settings`. The portal only changes those values later.

## 4. Build order

0. **De-risk first — nodejs-mobile spike.** Build the Node payload with Baileys for `arm64-v8a`, deploy to the Huawei P30 Pro, confirm the socket pairs by QR and stays connected. Everything below assumes this works; if it doesn't, the architecture needs rethinking, so do not build UI before this passes.
1. **Scaffold** — Capacitor Android project, Node payload skeleton with the IPC bridge, Supabase project with `message_history`/`image_sessions`/`contact_meta` + RLS policies, the private `user-images` Storage bucket + folder-prefix policies, and local SQLite (`outbox`, `image_cache`).
2. **Auth** — Supabase Google provider; native Google Sign-In → `supabase.auth.signInWithIdToken` on Android; gate the app behind a session; `core-server` JWT middleware.
3. **WhatsApp core** — Baileys socket in Node with QR delivery and reconnect-with-backoff; the WebView-owned `outbox` durability loop (write PENDING → hand to Node → persist each result → mirror to Supabase).
4. **Contacts + NL matching** — contacts read with real E.164 normalization via `libphonenumber-js` and a `needsReview` bucket; SIM-region default with user override; `onWhatsApp()` registration check; `contactMatcher` on `core-server`.
5. **Image generation/search + refine loop** — provider adapters on `core-server`, upload to the private bucket with server-constructed paths, signed-URL download, per-user local cache with eviction, `image_sessions`, refine UI. The isolation suite (`test-plan.md` §2) must pass before this step is considered done.
6. **Photo library save** — `NativeBridge.saveImageToLibrary` via MediaStore insert (a plain file write will not appear in Gallery).
7. **Wire the end-to-end flow** — contact match → image create/refine → save (optional) → confirm batch size → send.
8. **Hardening** — reconnect/offline states, provider failures, the claimed-but-unsettled duplicate-send prompt, foreground-service lifecycle, Huawei battery-whitelist prompt, image generation cost caps.

Steps 0–7 are done (send wizard verified end to end on the emulator). The CRM phase continues:

9. **Tenancy foundation** — migration: `organizations`, `org_members`, `org_invitations`, `is_org_member`/`has_org_role` helpers, `org_id` on `message_history`/`image_sessions`/`usage_daily`, org-prefixed storage policies, backfill a personal firm for existing users. `core-server`: org-membership middleware (`X-Org-Id`), org-scoped repositories and paths, `POST /orgs`, invitations. Firm-axis isolation tests (§15.9) must pass before step 10. **Done, and verified live (2026-09-14):** the migrations are applied to the real Supabase project and `core-server/test/live` (`npm run test:live`, 43 cases) re-runs TEN-02..27, TEN-30..33 and ISO-07 against it with four real accounts and two firms — real RLS, real Storage policies, real JWTs. Still outstanding there: TEN-01 (catalog audit), TEN-19 (backfill), TEN-22 (account deletion), TEN-26/28/29 (Realtime) and the device cases.
10. **App shell** — bottom navigation (Clients · Matters · Tasks · Messages), firm onboarding screen, firm switcher, members & invitations under Settings.
11. **Clients** — `clients` table + RLS, list/detail/edit, phone-contact import with E.164 normalization and dedupe, consent/suppression; the send wizard picks recipients from firm clients.
12. **Matters** — `matters`, `matter_clients`, list/detail/edit, link clients.
13. **Tasks** — `tasks`, grouped list, create/edit/complete, link to matter and assignee.
14. **Browser client (§15.10)** — `web-ui` Vite shell mounting the shared app from `shared-ui` with a browser platform implementation (OAuth redirect sign-in, localStorage, invite links). Sending from the browser queues a `send_jobs` row that the user's own phone claims atomically and sends. Local dev only for now.
15. **Message history** — per-batch history screen; client detail shows messages sent to that client.

## 5. Decisions still needed before/during implementation

- Which concrete LLM, image-generation, and image-search providers to use first (accounts/API keys).
- **Google Play vs sideload.** Play needs a current `targetSdk`, blocks `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` without an exemption, and its policy is hostile to WhatsApp bulk-messaging apps. Resolve before building if Play is the target.
- Starting values for the quota, retention and pacing settings (`crmex.md` §13.3). The admin portal is designed but not being built, so these need sensible seeded defaults shipped alongside the enforcement code.
- How much contact metadata is safe to send to an external LLM for NL matching vs. handled by a local heuristic first.
- SIM-region detection needs a small custom Capacitor plugin (`TelephonyManager.getSimCountryIso()`) or an accepted fallback to device locale.
- **Scheduling, processes and reminders** (`crmex.md` §16, designed 2026-09-17, under review): resolve decisions D1–D8 in §16.13, then add its build steps (§16.10) to §4 and remove "campaign scheduling" / "push reminders" from the out-of-scope list in §3.
- **Agentic engine — gyrfalcon** (`crmex.md` §17, designed 2026-09-17, under review): resolve G-D1..G-D7 in §17.10; gyrfalcon-side changes G1–G6 (§17.9) gate production use.
- **Decided 2026-09-17:** consent is **opt-out**. The client-level "Opted out" flag (`clients.suppressed_at`) controls every message, manual or scheduled; `opted_in_at` is informational and never gates sending (`crmex.md` §12).
- **Decided 2026-09-13:** invitations go by **email or QR code** (the app shows a QR code and a share/email link; email opens the device mail composer until server-side email is configured). Existing test data moves into a **"Demo Firm"**. The **operator (platform admin) sees firms and their users** — firm name, plan, members' names/emails/roles — **but never firm data** (clients, matters, tasks, messages, images, per-member activity).

---

*Update this file as decisions are made or scope changes — it should stay a short, current punch list, not a history log.*
