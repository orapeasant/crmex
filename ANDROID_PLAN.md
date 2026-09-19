# ANDROID_PLAN.md — Android development plan

The Android slice of CRMEX, extracted from `docs/spec/crmex.md` (§ references below),
`docs/spec/test-plan.md`, `PLAN.md`, `android/README.md`, and a check of the code in
`android/` and `shared-ui/`. Written 2026-09-19.

**Split of plans:** `PLAN.md` covers `core-server`, `shared-ui`, `web-ui` and `supabase/` only; **this file holds everything specific to the Android app.** Work that needs both (the assistant, the composer) has its server/shared half in `PLAN.md` and its phone half here.

**This file is derived, not a new source of truth.** If it disagrees with `crmex.md`,
the spec wins — fix this file. Scope or decision changes go into `crmex.md`, `test-plan.md`
and `PLAN.md` first (project rule), then here.

---

## 1. What Android is responsible for

Android is the only client that can **send WhatsApp messages**. Everything else in the
product (CRM, drafting, images, calendar) is shared React in `shared-ui` and also runs in
the browser (`web-ui`). So the Android-specific work is exactly the set of things a
browser cannot do:

| Android owns | Why only Android |
| :--- | :--- |
| The Baileys socket + pacing loop (embedded Node) | WhatsApp sessions are bound to one device pairing (§3.4); the server never holds one (§15.10) |
| Running `send_jobs` for its user (claim → outbox → Node → mirror) | Browser and scheduled sends are queued rows that *this user's phone* executes (§15.10, §16.7, §18) |
| Local SQLite: `outbox`, `image_cache` | Durability across app kills (§3.2) |
| Phone address-book import, SIM region | Native APIs (§7) |
| Save to Photos (MediaStore) | Native API (§8.4) |
| Native Google sign-in | Token acquisition is platform-specific (§5) |
| Foreground service, battery whitelist, OS notifications | Background execution reality (§10) |
| QR scanning + `crmex://invite/<token>` deep links | Firm invitations (§15.2) |

Everything Capacitor-specific lives behind `PlatformServices`
(`shared-ui/src/app/platform.ts`), implemented in `android/src/native/CapacitorPlatform.ts`.
`android/src/main.tsx` only builds the Supabase client and mounts `<CrmexApp>`.

### Invariants that bind Android (§1, §3, §9)

1. **No AI provider keys on the device**, ever. All AI goes through `core-server` (§1, invariant 1).
2. **Embedded Node does Baileys and nothing else** — no database, **no HTTP server**. The
   WebView talks to it over the `capacitor-nodejs` IPC bridge, which has no listening port (§9.1).
3. **The device holds caches and in-flight state only.** Supabase is authoritative (§1, invariant 3).
   Every local table carries `user_id` and every query filters on it (§3.2).
4. **The WebView owns durability, Node owns pacing.** A batch is written to `outbox` as
   `PENDING`, marked `CLAIMED` *before* the IPC hand-off, and each result is persisted and
   mirrored to `message_history` by the WebView (§9.2).
5. **Never silently resend a claimed-but-unsettled row.** Surface it as "may have been sent" (§9.2).
6. **A natural-language query never sends anything by itself.** Recipients are confirmed
   first, behind the two-tap `SendConfirmation` gate showing the batch size (§7.4, §12).
7. **Signed image URLs are bearer credentials** — don't log or persist them (§3.3).
8. **Sending is ordinary rate-limited batch delivery**, to people who expect to hear from
   the user. Pacing is not an abuse-detection countermeasure (§9.4, §12).

---

## 2. Current state

Sources: `PLAN.md` (steps 0–15 marked done), `android/README.md`, and the code as it stands.
**Caveat:** `android/README.md` is partly stale (it still says `App.tsx` only does sign-in →
QR and that `shared-ui` has 69 tests; the app now has the full shell and 113 tests). Treat
the README's *device-validation* table as accurate and its *what's built* section as outdated.

### Built
- Capacitor shell (`compileSdk`/`targetSdk` 36, `minSdk` 24), mounts the shared app.
- Embedded Node payload (`nodejs-assets/nodejs-project`: `main.js`, `pacing.js`), Baileys
  only; reconnect with backoff, QR delivery, `loggedOut` handling.
- Four custom Java plugins: `SimRegionPlugin`, `BackgroundEnginePlugin` + `BackgroundEngineService`,
  `BatteryWhitelistPlugin`, `MediaSavePlugin`.
- Native layer in `android/src/native/`: `CapacitorPlatform`, `CapacitorNativeBridge`,
  `SqliteLocalStore`, `contactsAdapter`, `nodeBridge`, `simRegionPlugin`, `customPlugins`.
- Platform features present per the README: Preferences, native Google sign-in, SQLite
  outbox + cache purge, SIM/locale region, phone contacts, ML Kit QR scanning,
  `crmex://invite/<token>` deep links, hardware back, Share sheet, Baileys over IPC.
- Send pipeline in `shared-ui/src/send/`: `queueBuilder`, `outboxManager`, `sendFlow`
  (durable write before IPC hand-off), `confirmationGate`, `directSender`, `jobRunner`
  (runs the user's own `send_jobs`), all with unit tests.
- App shell and CRM screens (Clients · Matters · Tasks · Messages), firm onboarding /
  switcher / invitations (PLAN steps 9–15).

### Verified on a device or emulator (from the README)
- Baileys connects and emits a QR (host); Gradle build incl. 3-ABI JNI compile succeeds.
- On the **emulator** (API 36, x86_64): app installs, Node starts, socket reaches WhatsApp,
  `wa:qr` renders as a scannable image, all 9 plugins register, and **AND-09** (no listening
  TCP port) passes. PLAN.md also records the send wizard verified end to end on the emulator.

### Not yet verified — needs the physical Huawei P30 Pro (API 29, arm64-v8a)
**The device is reachable now:** `adb devices -l` on 2026-09-19 listed `VOG_L29`
(serial `MQS7N19425001545`) alongside the emulator, so A1 is unblocked. The README says the
device was unreachable during its session and explicitly declines to claim these. **I could not confirm from the repo that any of them has since been run:**
real pairing (WA-02), **AND-10** (arm64 payload — the original build-order gate), Doze/EMUI
kill behaviour, the real `READ_CONTACTS` flow, Gallery visibility of a saved image, a real
foreground-service-driven batch.

### Not built (designed only)
Everything in §16 (device notifications) and §19 (occasion rules), plus FCM wake-up.
**§18 (campaigns) is no longer in this list:** the migration, `POST /images/upload`, the
`shared-ui` data layer and the wizard were built 2026-09-19. What remains is phone-side and
listed in §4.3. See §4 and §5 below.

---

## 3. Requirements by area

### 3.1 Authentication (§5)
- Native Google Sign-In → ID token → `supabase.auth.signInWithIdToken({ provider: 'google', token })`.
  Preferred over browser redirect (no custom scheme / `appUrlOpen` handling for auth).
- The `serverClientId` in `capacitor.config.ts` must be the **Web** client ID, not the
  Android one, so the token audience matches what Supabase expects. The README says it is
  still a placeholder — **needs the real value**.
- Plugin in use is `@southdevs/capacitor-google-auth` (the spec's `@codetrix-studio` build
  is pinned to Capacitor 6 and can't coexist with `capacitor-nodejs`'s Capacitor 8).
- Sign-out purges the signed-out user's image cache and clears all scheduled local
  notifications (ISO-13, SCH-16).

### 3.2 Local storage (§3.2, §3.3)
- SQLite in the **WebView** via `@capacitor-community/sqlite` — not in Node.
- `outbox(id, user_id, batch_id, jid, body, media_path, status, attempts, claimed_at)` with
  status `PENDING | CLAIMED | SENT | FAILED`; index on `(user_id, status)`.
- `image_cache(media_path, user_id, local_file, bytes, cached_at, last_used_at)`; index on
  `(user_id, last_used_at)`. Evict by `last_used_at` against a size budget.
- Image files: `Directory.Cache/images/<user_id>/<sha256>.png`. `PLAN.md` §2 says firm-scoped
  storage paths are `<org_id>/<user_id>/<sha256>.png`; the cache layout should follow whichever
  the shipped code uses (check `shared-ui/src/cache`).
- WhatsApp auth folder (`useMultiFileAuthState`) is app-private and **never synced**.
- **Firm dimension (§15, TEN-37):** switching the active firm must never replay another
  firm's unsent `outbox` rows; the firm list is re-validated on launch and a removed
  membership purges that firm's local cache. Check that `outbox` rows are scoped by firm as
  well as user — the §3.2 schema shows only `user_id`.

### 3.3 Contacts and phone numbers (§7)
- Plugin API is `checkPermissions()` / `requestPermissions()` returning
  `{ contacts: 'granted' | 'denied' | 'prompt' }` — verify against the installed major version.
- Real E.164 normalization with `libphonenumber-js` and a default region; unparseable
  numbers go to a **`needsReview` bucket**, never guessed. Region precedence: user override →
  SIM country → locale → hard default.
- SIM region needs the custom `SimRegionPlugin` (`TelephonyManager.getSimCountryIso()`).
- `sock.onWhatsApp(jid)` registration check before queueing; unregistered → `SKIPPED`, not `FAILED`.
- Contact import feeds firm `clients` (Supabase), deduped. NL matching runs on
  `core-server` against a **compact** index — no raw phone numbers or message bodies (§7.4).

### 3.4 WhatsApp engine (§9.3, §9.4)
- `main.js` responsibilities: build socket with `fetchLatestBaileysVersion()`, emit
  `wa:qr` / `wa:ready` / `wa:logged-out` / `wa:result` / `wa:batch-done`, reconnect with
  capped exponential backoff (max 30 s) on every close **except** `loggedOut`.
- Sequential sends with a randomized gap; media sent as `{ image, caption }`.
- The payload must have **zero native modules** (no `sqlite3`) — verified by the spike.
- `pacing.js` is a hand-synced plain-JS copy of `shared-ui/src/pacing/pacing.ts` (Node can't
  import `shared-ui`). Any change to one must be made in the other.
- Confirm the current Baileys package/version at each upgrade (`baileys@6.7.24` was used in
  the spike; the API has broken between minors).

### 3.5 Send pipeline (§9.2, §9.5, §15.10)

```text
confirm gate -> outbox PENDING -> CLAIMED -> IPC hand-off to Node
             -> per result: update outbox + mirror message_history -> delete settled row
```

- Two entry points share this path: the **direct sender** (user composes on the phone) and
  **`jobRunner`** (runs `send_jobs` the same user queued from a browser or a schedule).
- `send_jobs` claim is an atomic conditional update (`where status = 'queued' and
  created_by = auth.uid()` returning the row); the phone subscribes over Supabase Realtime
  **and** polls on launch/resume. Only the creator's phone may run a job (TEN-24, TEN-28).
- **Re-check at claim time, on the phone:** suppression (`suppressed_at`), batch-size limit,
  and (from §18) client `status = 'active'` and phone number present (SAF-06, CAM-08).
- Mirror failures must retry **without resending** (SEND-13).
- Template rendering uses `replaceAll` for `{name}`; nameless recipient → phone-book name,
  else skipped and reported (§9.5, C-D4).
- Foreground service starts when a batch begins and stops when the queue drains (AND-01/02).

### 3.6 Background execution (§10.2)
- A foreground service **resists** Doze; it does not make the process unkillable.
- Android 14 caps `dataSync` foreground services at ~6 h / 24 h → `onTimeout` must stop the
  service cleanly; the batch resumes via `outbox` (AND-07).
- **Huawei/EMUI kills aggressively.** The standard AOSP battery-optimization exemption can be
  requested in code (`BatteryWhitelistPlugin`), but there is **no public API for Huawei's
  separate "Protected apps" list** — that step must remain a documented manual instruction
  plus an in-app prompt when throttling is detected (AND-08).
- Accepted limitation, to state in the UI: a queued or scheduled job only runs **while the
  phone is online with CRMEX alive**. No FCM wake-up in this phase.

### 3.7 Manifest and platform (§10.1)
Required: `READ_CONTACTS`, `INTERNET`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_DATA_SYNC` (API 34+), `WAKE_LOCK`, `POST_NOTIFICATIONS` (API 33+),
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (Play-restricted), service with
`foregroundServiceType="dataSync"`, `exported="false"`.

Observed in `AndroidManifest.xml` vs the spec:
- All of the above are present.
- **`WRITE_CONTACTS` is declared but is not in the spec** — confirm it is needed (the spec
  only reads contacts). It is a bigger ask on the Play data-safety form and to users.
- `WRITE_EXTERNAL_STORAGE` is present (needed only for API 28 and below, SAV-02) — check it
  carries `maxSdkVersion="28"`.

### 3.8 Save to Photos (§8.4)
`MediaSavePlugin` must use a **MediaStore insert** on Android 10+ — a plain file write does
not appear in Gallery (SAV-01). API 28 and below needs `WRITE_EXTERNAL_STORAGE` (SAV-02). It
is the only path that writes outside app-private storage, and only on explicit user action.

### 3.9 Invitations (§15.2, §15.10)
ML Kit barcode scanning for invite QR codes; `crmex://invite/<token>` deep links;
share / email-composer for outgoing invites. (The browser instead uses `/invite/<token>` or
a pasted code.)

---

## 4. Planned work that touches Android (designed, not built)

### 4.1 Device notifications — §16.6.2, build step 19
- Schedule OS alarms with `@capacitor/local-notifications` for the user's reminders in the
  **next 14 days, across all their firms**. Resync on launch, resume, Realtime change and
  sign-in; **cancel all on sign-out**; drop a firm's notifications when its membership fails
  re-validation (SCH-16).
- Content is **minimal by default** ("Hearing tomorrow 09:30 · Matter 2026-014"); client
  names only if a firm setting allows.
- Permission flow (API 33+ `POST_NOTIFICATIONS`), Settings → Notifications screen showing
  permission status and the Huawei whitelist prompt.
- Honest limit: AlarmManager alarms usually fire with the app killed, but EMUI can still
  suppress them. **Do not call reminders "critical" in the product** until a channel that
  does not depend on the phone exists (email, or FCM — decision D1).
- The package is already a dependency, but no code under `android/src` or `shared-ui/src`
  references it yet.

### 4.2 Client messages from reminders — §16.7, build step 21
Phone-side changes to the same `send_jobs` path: never claim a job past `expires_at`
(default window 6 h); on `requires_approval = true` (default) show the approval
notification and only **insert** the `send_jobs` row when the user taps Send; the claim
predicate gains `expires_at > now()`. Sent through the normal outbox path so it lands in the
client's history.

### 4.3 Campaigns — §18, `PLAN.md` step 16
Phone-side (the wizard is `shared-ui`, so most of it is shared UI):
- **`jobRunner.ts`:** `listRunnableJobs` filters on `scheduled_at <= now` and
  `expires_at > now`; the pacing window handed to Node comes from the **job** (`interval_ms`
  with `jitter_pct`), not the global default; expired jobs are reported.
- **Paused — resume:** a `claimed` job with unsettled `outbox` rows and no running batch is
  shown as Paused and never silently restarted (CAM-09).
- **Concurrent runs (C-D3, revised 2026-09-19 — was "sequential"):** two campaigns due
  together **interleave**, sharing the pacing floor between any two messages, so neither waits
  for the other. The exception is a campaign of **under 20 recipients**, which is started
  1–2 minutes later instead: a short run loses little by waiting and keeps its stated pacing
  exactly true, whereas making a 400-recipient run wait hours is not an option (CAM-19).
  Consequence for the phone: the interval it is given is a **floor**, not a promise, once a
  second campaign is live.
- **Device presence (§18.6, new 2026-09-19):** the phone upserts a `device_presence`
  heartbeat (`user_id`, `device_id`, `label`, `last_seen_at`, `app_version`) on launch, on
  resume and on the job-poll tick. This is what lets the campaign list answer "will this
  actually run?" *before* the scheduled time rather than after it expires (CAM-21, CAM-22).
  It is a new phone responsibility, small but not optional — without it the last-seen line
  has nothing to read.
- Compose flow steps 4–5 (image source, schedule and pace with the duration estimate
  "412 recipients · every 30 s (±25 %) · finishes ≈ 12:26").
- **Pasted/attached images** go to `POST /api/v1/images/upload` (PNG only, metadata chunks
  stripped server-side; the client converts to PNG first, e.g. `canvas.toBlob`). Phone photos
  carry GPS — this matters for law-firm clients.
- The device clock is untrusted for schedule enforcement: the DB trigger uses Postgres
  `now()`, so a skewed phone can only delay itself (§18.3).
- A phone-created campaign needs connectivity at compose time (C4); immediate sends still
  work offline via the direct path.
- Campaign list shows status, derived progress, cancel, and the creator phone's last-seen
  (from `device_presence`; members read a colleague's `last_seen_at` but not their device
  `label` or `app_version` — §15.5).
- **Recipient overlap (C-D6, new 2026-09-19):** above 10 % shared recipients with another
  campaign due the same day, the wizard warns with the counts and offers remove / reschedule
  / send anyway. Shared UI, so nothing Android-specific — but it never auto-excludes, so the
  phone still receives exactly the list the user approved.
- Decided 2026-09-18: default interval 30 s, floor 10 s (`pacing.min_interval_ms`), reuse
  `limits.max_batch_recipients`, cancel-and-recreate (no edit). Decided 2026-09-19: C-D3 above,
  C-D6 above, and C-D4 closed as **moot** — `clients.display_name` is `not null` with a
  1–200 character check, so no `{name}` fallback is reachable.

### 4.4 Occasion rules — §19, `PLAN.md` step 18 (needs §16 stage 1, step 17)
Mostly server-side (scanner in the dispatcher) and shared UI. The Android-specific part is
only that its output arrives as the §4.1 notification and the §4.2 approval → `send_jobs`
insert. Staggered fire times (forty birthdays spaced by `pacing.min_interval_ms`) mean the
phone still sees one job at a time. Nothing new for the phone to send with.

### 4.5 FCM wake-up — §18.9, deferred
Register a device token per `created_by`; a data-only push makes the phone poll
`listRunnableJobs` sooner. **Never a second sender** — the atomic claim still decides.
Needs a Firebase project and a device-token table. Not scheduled.

**Direction (decided 2026-09-19):** the server will drive the schedule and the phone stays a
gateway that only sends. That dispatcher is built **with §16**, which needs the same tick —
not before it. For Android this changes nothing structurally: the phone keeps claiming, the
trigger keeps enforcing the window, and a dispatcher (or a push) only shortens the delay
before a claim happens.

### 4.6 Agentic engine — §17
Server-side (`core-server` → gyrfalcon). Android inherits any chat UI from `shared-ui`; I
found no Android-specific requirements in the parts of §17 I searched (I did not read it in
full).

### 4.7 Voice — §21, merged into the assistant by §22
Android implementation (the browser's Web Speech API version is in `PLAN.md` step 20). **Guided mode** (no AI, no server call, works offline) stays as designed in §21.4.
**Smart mode is replaced by the assistant** (§4.8): a recording is transcribed on the phone and sent
as a prompt to `POST /assistant/runs`; the dedicated voice-draft endpoint no longer exists.
Needs a **speech spike on the P30 Pro first**: `@capacitor-community/speech-recognition` 7.0.1 vs
Capacitor 8.5.2 (unproven), or a custom `SpeechRecognizerPlugin` like the four existing Java
plugins; new `RECORD_AUDIO` permission and a `<queries>` entry for `android.speech.RecognitionService`.
The phone has Google's recognizer (`googlequicksearchbox`); the **emulator has none**, so speech can
only be tested on the phone. Audio may reach Google's servers unless offline recognition applies; an
owner switch requires on-device-only (API 33+; the P30 Pro is API 29, so it would disable voice there).
Languages: English, Malay, Mandarin, one per recording.

**Decided 2026-09-19:** community plugin only (V-D2). If the spike fails on Capacitor 8, stop and ask — no custom plugin without a new decision. Best-effort on-device with an owner switch (V-D1); Mandarin only (V-D4); replies read aloud only if a member turns the speaker on (V-D3).

### 4.8 The assistant on Android — §22
The server half (engine adapter, settings, executor, read tools, kill switches) is `PLAN.md` step 20.
Phone half:
- **Assistant sheet:** streams text over SSE, renders **result cards** ("Created client … · Open", Confirm / Reject for Ask, Undo for Auto), and learns of created rows over Supabase Realtime plus the existing `bump()` refetch. Recovers when SSE drops.
- **Entry points:** a floating assistant button on every main screen; the sheet inside Messages Compose; contextual on matter and client detail; **New by voice** on the Clients, Matters and Tasks lists.
- **Disabled state:** call `GET /assistant/status`; on `AI_DISABLED`, keep the button but show *"AI is turned off by your firm owner"* or *"AI is temporarily unavailable"*. Manual entry, Guided voice and the composer keep working.
- **Agent setup screens** (Settings → AI assistant): owner sections and member preferences per §22.6. **Design only for now — not to be built before approval.**
- **Inbox:** an inbox row with a badge. **No push and no local notification for agent runs** (decided 2026-09-19); results are seen when the app is opened.
- Nothing on the device holds a model key; the model is chosen server-side per firm.

### 4.9 Composer, schedule step and cancel on Android — §23
The server/shared half is `PLAN.md` step 21. Phone half:
- **Cancel path in `jobRunner.ts`:** watch `send_jobs` over Realtime; **check `cancel_requested_at` before every send**; on request, stop, set the remaining `outbox` rows to a new `CANCELLED`, write `CANCELLED` to `message_history` for the unsent, and finish the job `cancelled` with honest counts. At most one message may complete after the request.
- **Never resume** a job that has `cancel_requested_at` — relaunch and "Paused — resume" both skip it.
- **Offline phone:** the request stays pending; the UI says "Cancel requested — waiting for the phone".
- **Composer** (Compose · Schedule · Review) and **Drafts** are shared UI; on Android, leaving asks Save draft / Discard / Keep editing, and the Schedule stop shows which phone will send and its last-seen time.
- **Draft edit lock:** take the edit lease when a draft opens, renew it every 30 s, show read-only with **Take over** when another device holds it, and let it expire on its own if the phone dies.
- **New device tests:** MSG-03, MSG-08, MSG-16..18, MSG-22, MSG-23, MSG-27 (test plan §25).

---

## 5. Roadmap (Android view)

Ordered by what unblocks the most; A1 is the only real gate.

| # | Item | Depends on | Notes |
| :--- | :--- | :--- | :--- |
| A1 | **Device validation on the Huawei P30 Pro** — AND-10, WA-01..08, AND-01..11, SAV-01, contacts permission, a real send batch | Device reachable (it is, as of 2026-09-19) | The one gate from the original build order still open. Everything below assumes it passes. |
| A2 | Real credentials: Google **Web** client ID in `capacitor.config.ts`, Supabase env in `android/.env`, deployed `VITE_CORE_SERVER_URL` | Supabase / Google projects | Emulator default is `http://10.0.2.2:8080/api/v1` |
| A3 | Hardening (PLAN step 8): offline/reconnect states, provider failures, claimed-but-unsettled prompt, service lifecycle, Huawei whitelist prompt, image cost caps | A1 | |
| A4 | Manifest audit: `WRITE_CONTACTS`, `WRITE_EXTERNAL_STORAGE maxSdkVersion` | — | See §3.7 |
| A5 | **Distribution decision**: sideload vs Google Play | — | Blocks whether `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` ships; Play policy is hostile to WhatsApp bulk-messaging apps. Resolve *before* release work. |
| A6 | Release build: signing config, split-ABI APKs / App Bundle (debug APK is ~175 MB with `libnode.so` × 3 ABIs) | A5 | `targetSdk` is already 36 |
| A7 | Campaign phone-side work (§4.3): presence heartbeat, interleave + under-20 stagger, Paused-resume, expired reporting | Migration applied | PLAN step 16. Server and shared-UI parts are **done** (2026-09-19); §18's decisions are all closed. The migration is written but **not applied**, which is the actual blocker. |
| A8 | Device notifications (§4.1) + notification settings + Huawei prompt | Spec §16 approval; §16.10 steps 16–18 (schema, calendar UI, dispatcher) | §16.10 step 19 |
| A9 | Reminder client messages (§4.2) | A8; §16.10 step 21 | |
| A10 | Occasion-rule approval path (§4.4) | A9; §19 build steps | Minimal Android work |
| A11 | Reliable staff channel — email or FCM (§16.13 D1, §18.9) | Decision D1 | Email is the recommendation; FCM later |
| A12 | **Voice** (§4.7): speech spike on the phone, then Guided mode; recording feeds the assistant (A13) | Spec §21 approval; PLAN step 19 (numbering) | Smart mode is replaced by A13 |
| A13 | **Assistant sheet, entry points, disabled state, inbox** (§4.8) | Spec §22 approval; PLAN step 20 server half | Agent setup screens: design only for now |
| A14 | **Composer phone path: draft rendering, Schedule stop, cancel-before-next-send** (§4.9) | Spec §23 approval; PLAN step 21 server/shared half | Replaces the old §18.6 rule |

`PLAN.md` step 16 (§18 campaigns) is **built** as of 2026-09-19, apart from the phone-side
items in §4.3 and with the migration not yet applied. Steps 17 (§16 stage 1) and 18 (§19) are
decided in principle but not started: §16.13 D1–D8 are still open and gate stage 1.

---

## 6. Android test cases (`test-plan.md`)

Levels: **D** device, **M** manual, **I** integration, **U** unit.

| Area | IDs | Level |
| :--- | :--- | :--- |
| Android platform | AND-01..AND-06, AND-09..AND-11 | D |
| | AND-07 (Android 14 cap), AND-08 (OEM kill) | M |
| WhatsApp session | WA-01..03, WA-06, WA-08 | D |
| Sending | SEND-11 (batch-done stops the service) | D |
| Photo save | SAV-01, SAV-02 | D (SAV-05 is M) |
| Isolation | ISO-13 (sign-out purges cache) | D |
| Multi-tenancy | TEN-28 (two devices, one claim), TEN-37 (firm switch with unsent outbox) | D |
| Scheduling | SCH-16 (sign-out clears local notifications) | D |
| Campaigns | CAM-09 (kill mid-campaign → Paused/resume), CAM-10 (concurrent runs: interleave, under-20 stagger) | D |
| Cross-platform | XPL-05 (no `admin-ui` assets in the APK) | U — build-time assertion over the APK |

The unit and integration halves of these areas are covered by the offline suites
(`shared-ui` 113 tests). **Do not load-test delivery.** Every message goes to a real person;
verify pacing and volume by asserting on timing and queue state, not by sending hundreds
(test plan, conventions).

---

## 7. Open decisions that affect Android

| Decision | Source | Status |
| :--- | :--- | :--- |
| Play Store vs sideload | §10.3, §14 | **Open** — gates the battery permission, release signing, distribution format |
| Reliable staff reminder channel: email / FCM / local-only | §16.13 D1 | Open — recommendation: email next |
| Tasks vs events in the tab bar (5 tabs is the phone maximum) | §16.13 D2 | Open |
| Where the dispatcher runs | §16.13 D4 | Open (server-side, but affects late-reminder behaviour) |
| Timezone of client messages | §16.13 D6 | Open — recommendation: client's own, else firm's |
| SIM region: custom plugin vs locale fallback | §14 | Plugin built; on-device behaviour unverified |
| Contact metadata sent to the LLM for NL matching | §14 | Open |
| `minSdk` 24 vs the API 29 test device | §11.5 | **Open** — at 24 the API 28-and-below save-to-Photos path (SAV-02) ships to real users but cannot be exercised on the P30 Pro; raising to 29 drops Android 7–9 devices |
| §18 C-D1, C-D2, C-D5 | §18.8 | **Decided 2026-09-18** (30 s default, floor 10 s; reuse batch cap; cancel-and-recreate) |
| §18 C-D3 (concurrent campaigns), C-D6 (recipient overlap) | §18.8 | **Decided 2026-09-19** — interleave, except under-20 runs start 1–2 min later; warn above 10 % overlap |
| §18 C-D4 (`{name}` fallback) | §18.8 | **Closed 2026-09-19 as moot** — `display_name` is `not null`, so no fallback is reachable |
| §18.6 device presence | §18.6 | **Decided 2026-09-19** — phone writes a `device_presence` heartbeat; see §4.3 |
| Where the campaign schedule is driven from | §18.6 | **Decided 2026-09-19** — server-side dispatcher, built with §16; phone stays a gateway |
| §16 scope and ordering | `PLAN.md` step 17 | **Decided 2026-09-19** — staged: `events` + `event_reminders` + dispatcher tick first; templates, move functions and overdue sweep deferred |
| Occasion rules O-D1..O-D5 | §19.7 | Open |
| Voice V-D1..V-D5, V-D7 (best-effort on-device + owner switch; community plugin only; text by default; Mandarin only; browser voice yes; `source='voice'`) | §21.9 | **Decided 2026-09-19**; V-D6 and V-D8 superseded by §22 |
| Assistant AG-D5 (completion alert when the app is closed) | §22.14 | **Decided 2026-09-19: inbox only, never push** |
| Composer MSG-D1..D7 (3 stops; leased edit lock; `CANCELLED`; 30 min dead-phone cancel; duplicate; `pg_trgm`; creator + owner see drafts) | §23.6 | **Decided 2026-09-19** |

---

## 8. Risks, in order

1. **nodejs-mobile on real hardware.** Passed on the emulator only; the arm64 payload on the
   Huawei (AND-10) was the build-order gate and remains unclosed. If it fails, large parts of
   the design are invalidated (§10.4).
2. **Background reliability on EMUI.** Scheduled campaigns and reminder client messages
   depend on the phone being alive; Huawei's protected-apps list cannot be driven from code.
   Mitigations are detection, prompting, and honest UI copy — not a guarantee.
3. **Play policy.** Independent of code quality; decide before release work (§10.3).
4. **Duplicate sends.** A killed app between "handed to Node" and "result persisted" is the
   one place a real person can be messaged twice. The `CLAIMED` + surface-don't-resend rule
   is the whole mitigation — it must survive every refactor.
5. **Baileys drift.** Unofficial protocol; breaking changes between minors; pin and re-test
   on upgrade.
6. **Plugin/version coupling.** Capacitor 8 + `capacitor-nodejs` (pinned to a GitHub
   release tarball, `v1.0.0-beta.10`) constrains which community plugins can be used.

---

## 9. Explicitly not Android's job

- AI provider calls, quota and retention enforcement — `core-server`.
- Holding a WhatsApp session for anyone else, or on the server.
- The admin portal (§13) — web-only, never compiled into the APK (XPL-05 asserts it).
- Delivery / read receipts, message templates, SMS/email channels, calendar sync, iOS —
  out of scope for this phase (`PLAN.md` §3).

---

## 10. Dev workflow

- **There are two checkouts.** This WSL one (`~/app/claude/crmex`) has no
  `android/node_modules`; the Windows one (`/mnt/c/Users/orape/app/crmex`, reachable from WSL
  under `/mnt/c`) does, because that is where Gradle runs. Anything needing plugin sources or
  an Android build reads from the Windows copy — and the two can drift, so check which one a
  commit came from before assuming the tree is current.
- **Bring up the Android emulator from this Windows machine** (not WSL) whenever Android
  work needs a device. Android Studio, Gradle, `adb` and the emulator all run on Windows;
  see `android/README.md` for the build and install commands.
- Emulator reaches a `core-server` on the Windows host at `http://10.0.2.2:8080/api/v1`.
- The emulator is x86_64 and does not exercise the arm64 payload — it never replaces A1.
- With the phone and the emulator both attached, every `adb` command needs `-s <serial>`
  (or `-e` for the emulator, `-d` for the phone); Gradle's `installDebug` installs to both.
- AVD on this machine: `Medium_Phone_API_36.0`. SDK at `%LOCALAPPDATA%\Android\Sdk`.
  If adb reports a server/client version mismatch it restarts the daemon, which is harmless.

---

## 11. Discrepancies noticed while extracting this

Not fixed here; listed so they can be triaged.

Triaged 2026-09-19. Outcomes recorded inline.

1. ~~`android/README.md` predates the app shell~~ — **fixed.** Test count corrected (152, not
   69) and the "not built in this pass" section marked superseded, keeping the seam
   description which is still accurate.
2. ~~`WRITE_CONTACTS` has no counterpart in the spec~~ — **not a defect; spec updated.** The
   app never writes contacts, but `@capacitor-community/contacts` groups READ and WRITE under
   one permission alias and Capacitor refuses the alias request unless both are declared, so
   removing it would break contact import. The reason now lives in §10.1 as well as the
   manifest comment, because it is the permission a Play reviewer is most likely to query.
   Verified 2026-09-19 against `ContactsPlugin.java`:
   `@Permission(strings = { READ_CONTACTS, WRITE_CONTACTS }, alias = "contacts")`.
3. `@capacitor/local-notifications` declared but unused — **keep.** §16.6.2 makes it the
   phase-1 staff-reminder channel and §16 stage 1 is the next build step, so removing it now
   only to re-add it is churn. Revisit if §16 slips.
4. ~~Spec §3.2's `outbox` has no `org_id`~~ — **spec lag, not a code bug; spec updated.** The
   shipped schema has `org_id` (added by migration for pre-tenancy databases), plus
   `client_id` and `display_name`, and clearing is scoped by `(user_id, org_id)` per TEN-37.
   `image_cache` also keys on `(user_id, media_path)`, not a bare `media_path` — the code is
   right, since a global key would collide between two accounts on one device.
5. `minSdk` 24 vs the API 29 test device — **open, needs a product decision.** See §7.
6. ~~`PLAN.md` §3 still lists campaign scheduling as out of scope~~ — **fixed** for the
   campaign half; "push reminders" stays until §16 stage 1 lands.

---

## 12. Moved from PLAN.md (original Android build order and decisions)

These were in `PLAN.md` before it was limited to non-Android work. Step numbers match `PLAN.md`.

### Original build steps

0. **De-risk first — nodejs-mobile spike.** Build the Node payload with Baileys for `arm64-v8a`, deploy to the Huawei P30 Pro, confirm the socket pairs by QR and stays connected. Everything below assumes this works; if it doesn't, the architecture needs rethinking, so do not build UI before this passes.
1. **Scaffold** — Capacitor Android project, Node payload skeleton with the IPC bridge, Supabase project with `message_history`/`image_sessions`/`contact_meta` + RLS policies, the private `user-images` Storage bucket + folder-prefix policies, and local SQLite (`outbox`, `image_cache`).
2. **Auth** — Supabase Google provider; native Google Sign-In → `supabase.auth.signInWithIdToken` on Android; gate the app behind a session; `core-server` JWT middleware.
3. **WhatsApp core** — Baileys socket in Node with QR delivery and reconnect-with-backoff; the WebView-owned `outbox` durability loop (write PENDING → hand to Node → persist each result → mirror to Supabase).
4. **Contacts + NL matching** — contacts read with real E.164 normalization via `libphonenumber-js` and a `needsReview` bucket; SIM-region default with user override; `onWhatsApp()` registration check; `contactMatcher` on `core-server`.
6. **Photo library save** — `NativeBridge.saveImageToLibrary` via MediaStore insert (a plain file write will not appear in Gallery).
8. **Hardening** — reconnect/offline states, provider failures, the claimed-but-unsettled duplicate-send prompt, foreground-service lifecycle, Huawei battery-whitelist prompt, image generation cost caps.
19. **Voice matter capture (§21, after approval, needs §20)** — speech spike on the P30 Pro first, then `create_matter_bundle`, Guided mode + on-device client matching + review screen, then `POST /matters/voice-draft` and Smart mode, then owner voice settings. Android only.

Status: steps 0–7 were recorded as done on the emulator (send wizard verified end to end). Step 0 on the **physical device** was re-run on 2026-09-19: the payload loads on the P30 Pro, Baileys connects and a QR reaches the app; real pairing, background behaviour and the rest of the device checklist are still open (§2). The old step 19 (voice) is superseded by §4.7–§4.8.

### Architecture decisions (Android)

- **Android-first**: all core logic (LLM calls, image gen/search, contact matching, WhatsApp queue) lives in the Android app's embedded Node background engine. Web/Electron are future thin reuse targets via a shared UI layer — not built in this pass.
- **Local SQLite is durability and cache-index only**, not a source of truth: `outbox` so a batch survives an app kill, `image_cache` to track downloads. The WhatsApp `useMultiFileAuthState` folder is also device-local — a session is cryptographically bound to one device pairing.
- **Embedded Node does Baileys and nothing else**: no `sqlite3` (removes the native-module build risk), and **no local HTTP server** — the old localhost Express design bound to `0.0.0.0` and was reachable by anyone on the same Wi-Fi. Replaced by the `capacitor-nodejs` IPC bridge, which has no listening port.

Note: the first bullet is historical — LLM calls, image generation/search and contact matching now live in `core-server`, not in the embedded Node engine.

### Feature scope items that are Android-only

- Natural-language contact search over the phone's local address book (read via `@capacitor-community/contacts` or equivalent).
- Save current image to the device photo library.
- Select contacts (from NL match results) + send image/text via the embedded Baileys WhatsApp engine, with paced/sequential delivery.
- Send queue and image session history persisted in Supabase (source of truth); a local SQLite outbox absorbs sends mid-flight so the app survives being backgrounded/restarted or losing connectivity.

### Decisions that are Android-only

- **Google Play vs sideload.** Play needs a current `targetSdk`, blocks `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` without an exemption, and its policy is hostile to WhatsApp bulk-messaging apps. Resolve before building if Play is the target.
- SIM-region detection needs a small custom Capacitor plugin (`TelephonyManager.getSimCountryIso()`) or an accepted fallback to device locale.
- **Voice matter capture** (`crmex.md` §21, designed 2026-09-19; **V-D1..V-D5 and V-D7 decided 2026-09-19**, see §7; the original question was **V-D1** (the stock Google recognizer may send audio to Google unless an offline pack is used; the test phone is API 29 and cannot use the guaranteed on-device recognizer) and **V-D2** (community speech plugin vs custom Java plugin on Capacitor 8). Languages: English, Malay, Mandarin.
