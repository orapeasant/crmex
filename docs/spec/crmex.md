# CRMEX — Consolidated Architecture Specification

Single source of truth for the system design. Supersedes `android-whatsapp-gateway-design.md` and `ai-image-gateway-design.md`, both of which are retired into this file.

**What the product does:** a user logs in with Google, describes or searches for an image in natural language, refines it through an AI loop, optionally saves it to their phone's photo library, describes in natural language which of their contacts to target, and sends the image to those contacts over WhatsApp with paced sequential delivery.

**Primary target is Android.** The design keeps a deliberate seam so the same UI and server can later back a browser app and an Electron wrapper without rework.

---

## 1. System overview

Three tiers, with a strict rule about what each is allowed to do:

```text
┌─────────────────────────────────────────────────────────────┐
│  CLIENT (Capacitor WebView on Android / browser / Electron) │
│  React UI · local SQLite · contacts · photo library         │
│  Holds: Supabase session JWT, evictable local image cache   │
│  Never holds: AI provider keys                              │
└───────────────┬─────────────────────────┬───────────────────┘
                │ IPC bridge              │ HTTPS + JWT
                │ (Android only)          │
┌───────────────▼──────────────┐  ┌───────▼─────────────────────┐
│  EMBEDDED NODE (nodejs-mobile)│  │  CORE-SERVER (cloud)        │
│  Baileys WhatsApp socket only │  │  AI provider adapters       │
│  Pacing/worker loop           │  │  Holds AI provider keys     │
│  No database, no HTTP server  │  │  Verifies Supabase JWT      │
└───────────────────────────────┘  └───────┬─────────────────────┘
                                           │
                              ┌────────────▼──────────────┐
                              │  SUPABASE                 │
                              │  Auth · Postgres history  │
                              │  Storage (private bucket) │
                              └───────────────────────────┘
```

Three invariants that the rest of this document depends on:

1. **The client never talks to an AI provider directly.** Provider API keys exist only on `core-server`. A key shipped inside an APK or a browser bundle is a published key.
2. **The embedded Node process does nothing but WhatsApp.** It holds the Baileys socket and the send-pacing loop. It has no database and exposes no network port.
3. **Supabase is authoritative for everything a user owns** — auth, message history, image sessions, and the image files themselves. The device keeps only an evictable cache. Every one of those is partitioned per user, and no user can read another's rows or objects (§4).

**Agentic engine (§17, under review):** a private gyrfalcon service sits behind `core-server` for chat, flows and scheduled agent work. Clients never reach it, it never holds authoritative firm data, and its agents only produce proposals that a user confirms.

---

## 2. Repository layout

```text
crmex/
├── core-server/                    # Cloud service — the only holder of AI provider keys
│   ├── src/
│   │   ├── providers/
│   │   │   ├── llm/                # LlmProvider interface + per-vendor implementations
│   │   │   ├── image-gen/          # ImageGenProvider interface + implementations
│   │   │   └── image-search/       # ImageSearchProvider interface + implementations
│   │   ├── agent/
│   │   │   ├── contactMatcher.ts   # NL query -> ranked contact ids
│   │   │   └── imageAgent.ts       # generate / refine orchestration
│   │   ├── auth/middleware.ts      # verifies Supabase JWT on every route
│   │   └── api/                    # Express routes, /api/v1/*
│   └── package.json
├── shared-ui/                      # React components + apiClient + NativeBridge interface
├── web-ui/                         # Browser shell (future)
├── admin-ui/                       # Operator portal — web only, never in the APK or Electron
│                                   # (designed in §13, not implemented)
├── electron-shell/                 # Electron shell (future)
└── android/
    ├── app/src/main/AndroidManifest.xml
    ├── src/                        # Capacitor WebView app — renders shared-ui
    └── nodejs-assets/
        └── nodejs-project/         # nodejs-mobile payload
            ├── main.js             # Baileys socket + worker loop
            └── package.json        # deps: baileys only (no sqlite3, no express)
```

---

## 3. Storage model — what lives where, and why

This is the decision most likely to be misremembered later, so it is stated exhaustively.

### 3.1 Supabase Postgres — auth, message history, image sessions

Authoritative for anything a user should still see after reinstalling the app or logging in from another client.

```sql
-- Send history: one row per recipient per send
create table message_history (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
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
create table image_sessions (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  prompt_history  jsonb not null default '[]',   -- [{role, prompt, timestamp}]
  current_path    text,                          -- storage object path (§3.3)
  source          text not null,                 -- 'generated' | 'searched'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Optional per-contact metadata the user adds, used to sharpen NL matching
create table contact_meta (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  jid           text not null,
  tags          text[],
  notes         text,
  unique (user_id, jid)
);

alter table message_history enable row level security;
alter table image_sessions  enable row level security;
alter table contact_meta    enable row level security;

create policy own_rows on message_history
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on image_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on contact_meta
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```

The phone's address book itself is **not** uploaded. `contact_meta` holds only metadata the user deliberately attaches, keyed by JID.

### 3.2 Device-local SQLite — queue durability and cache index

Runs in the **WebView** via `@capacitor-community/sqlite`, not in the Node process (see §9.1 for why). It holds no authoritative data: everything here is either in-flight or a cache index.

```sql
-- Batch durability: written before any send is attempted, so a batch survives
-- the app being killed mid-run. Rows are cleared once mirrored to Supabase.
create table outbox (
  id           integer primary key autoincrement,
  user_id      text not null,
  org_id       text not null default '',  -- the firm the batch belongs to (§15, TEN-37)
  batch_id     text not null,
  jid          text not null,
  client_id    text,                 -- the firm client this recipient is, for mirroring
  display_name text,
  body         text,
  media_path   text,                 -- storage object path (§3.3), null for text-only
  status       text not null default 'PENDING',   -- PENDING | CLAIMED | SENT | FAILED
  attempts     integer not null default 0,
  claimed_at   integer               -- epoch ms, set when handed to the Node process
);

-- Index of which storage objects are cached on this device, for eviction.
create table image_cache (
  media_path   text not null,        -- same path as in Supabase Storage
  user_id      text not null,
  local_file   text not null,        -- filesystem path within the user's cache dir
  bytes        integer not null,
  cached_at    integer not null,
  last_used_at integer not null,
  primary key (user_id, media_path)  -- per user: a bare media_path key would let
);                                   -- two accounts on one device collide

create index outbox_pending on outbox (user_id, status);
create index cache_by_user on image_cache (user_id, last_used_at);
```

`org_id` is added by a migration on databases created before multi-tenancy, defaulting to `''`; a device that has never switched firms is unaffected. Clearing the outbox is scoped `where user_id = ? and org_id = ?`, which is what keeps Firm A's unsent rows from replaying while Firm B is active (TEN-37).

**Every table carries `user_id` and every query filters on it.** A phone can have more than one account signed in over its lifetime; one user must never read another's rows.

### 3.3 Images — Supabase Storage, cached on device

Image bytes live in a **private** Supabase Storage bucket, partitioned per user:

```text
bucket: user-images        (private — public buckets serve any object to anyone with the URL)
object path: <user_id>/<sha256>.png
```

Storage policies enforce the partition. Supabase Storage authorizes against the `storage.objects` table, so the folder-prefix pattern applies:

```sql
create policy own_images_read on storage.objects
  for select using (
    bucket_id = 'user-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy own_images_write on storage.objects
  for insert with check (
    bucket_id = 'user-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy own_images_delete on storage.objects
  for delete using (
    bucket_id = 'user-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

**Upload** happens on `core-server`, which already holds the bytes it just generated. It constructs the object path from the **JWT-derived** `user_id` — never from a client-supplied value — and returns the path to the client.

**Download** uses short-TTL signed URLs. A signed URL is a bearer credential: anyone holding it can fetch the object until it expires, so keep the TTL short (minutes), never log them, and never embed them in anything persisted.

**Device cache:**

```text
<app cache dir>/images/<user_id>/<sha256>.png
```

- `@capacitor/filesystem` with `Directory.Cache` — app-private and not world-readable. `Directory.Cache` rather than `Directory.Data` because this is now genuinely reconstructible: the OS may reclaim it and the app simply re-downloads.
- The cache is partitioned per `user_id` for the same reason the storage bucket is: a device can host more than one account over its lifetime.
- **Purge the signed-out user's cache directory on logout.** Under the previous device-authoritative design this would have destroyed data; now it costs nothing but a re-download, so it should be the default rather than an option.
- Evict by `last_used_at` against a size budget.
- "Save to Photos" is the only path that writes outside app-private storage, and only on explicit user action (§8.4).

This resolves the limitation the earlier design carried: every client, including the browser, can now re-render the images in a user's history rather than seeing only a hash.

**Cost note:** generated images accumulate in Storage indefinitely unless a retention policy exists. See §13.

### 3.4 WhatsApp session credentials

`useMultiFileAuthState` writes to app-private storage on the device. A WhatsApp Web session is cryptographically bound to one device pairing — it cannot be synced to Supabase or shared between clients. Each device pairs independently.

---

## 4. User isolation

> **Superseded in part by §15 (multi-tenancy).** The isolation boundary for CRM data (clients, matters, tasks, send history, images) moves from the individual user to the **firm** (tenant): members of one firm share that firm's data; nothing crosses between firms. Every rule below still applies with `user_id` read as "the caller's verified firm membership" wherever §15 scopes a table by `org_id`. Device-local state (SQLite, image cache, WhatsApp pairing) stays per user.

No user may see another user's images or messages. Called out separately because the failure modes here are quiet ones — they produce no error, just the wrong person's data.

| Layer | Rule |
| :--- | :--- |
| `core-server` routes | `user_id` is derived **only** from the verified Supabase JWT, never from a request body, query parameter or header. Accepting a client-supplied `user_id` is the classic IDOR hole. |
| Storage object paths | Built server-side as `<jwt_user_id>/<sha256>.png`. If any client-supplied string ever reaches a path, reject `..`, `/` and absolute paths — a traversal here reads or overwrites another user's objects. Prefer deriving the filename from a server-computed content hash so no client input touches the path at all. |
| Storage bucket | **Private**, never public. A public bucket serves every object to anyone who has or guesses a URL, and RLS does not apply to it. |
| Signed URLs | Short TTL (minutes). They are bearer credentials — do not log them, persist them, or return one for an object whose path was not derived from the caller's own `user_id`. |
| Supabase Postgres | RLS on every table (§3.1). `core-server` uses the service role key, which **bypasses RLS**, so it must apply its own `user_id` filter on every query. RLS is the second line of defence, not the only one. |
| Supabase Storage | Folder-prefix policies (§3.3). The service role bypasses these too, with the same consequence — server-side path construction is the primary control. |
| AI generation cache | Do **not** key a cache on prompt text alone. Two users submitting the same prompt must not receive the same cached object — key by `(user_id, prompt)` or do not cache. |
| Device SQLite | Every query filters `user_id = <active session user>`. |
| Device image cache | Per-`user_id` directory partition, app-private (`Directory.Cache`). Purged on sign-out. |
| Sign-out | Clear the Supabase session, the signed-out user's cache directory, and any in-memory image or contact state before another account can sign in. |

---

## 5. Authentication

Supabase Auth with the Google provider. All clients end up holding a Supabase session JWT that `core-server` verifies identically; only token acquisition is platform-specific.

- **Android:** native Google Sign-In (`@codetrix-studio/capacitor-google-auth` or equivalent) returns a Google ID token, exchanged via `supabase.auth.signInWithIdToken({ provider: 'google', token })`. This is preferred over the browser redirect flow — it avoids registering a custom URL scheme and handling `appUrlOpen` deep links.
- **Browser (future):** `supabase.auth.signInWithOAuth({ provider: 'google' })`.
- **Electron (future):** OAuth in a `BrowserWindow` with a custom protocol or loopback redirect, then the same token exchange.

`core-server` verifies every request with `supabase.auth.getUser(token)` in `auth/middleware.ts` and attaches the resulting `user_id` to the request context.

---

## 6. AI provider layer (server-side)

Each external AI capability sits behind a narrow interface, so the vendor is a configuration choice rather than a code change.

```typescript
export interface LlmProvider {
  chat(messages: ChatMessage[]): Promise<string>;
  agentTurn(messages: ChatMessage[], tools: ToolDef[]): Promise<AgentTurnResult>;
}

export interface ImageGenProvider {
  generate(prompt: string, opts?: { width?: number; height?: number }): Promise<GeneratedImage>;
  edit(baseImage: Buffer, instruction: string): Promise<GeneratedImage>;
}

export interface ImageSearchProvider {
  search(query: string, limit?: number): Promise<ImageResult[]>;
}
```

A factory reads `LLM_PROVIDER` / `IMAGE_GEN_PROVIDER` / `IMAGE_SEARCH_PROVIDER` from the environment and returns the configured implementation. `agent/` and `api/` import only the interfaces. Adding a vendor is one new file plus a registry entry.

Not all image providers expose an edit/inpaint endpoint. `ImageGenProvider.edit()` implementations for such vendors fall back to a fresh `generate()` with a prompt amended from the session's history — the interface hides the difference from callers.

---

## 7. Contacts and phone number normalization

### 7.1 Reading the address book

The previous draft used `Contacts.getPermissions()` and checked `permission.granted`. Neither exists in `@capacitor-community/contacts` v5+ — the API is `checkPermissions()` / `requestPermissions()` returning `{ contacts: 'granted' | 'denied' | 'prompt' }`. Verify against the version you install; this plugin's API changed between major versions.

### 7.2 E.164 normalization

The previous draft claimed to normalize to E.164 but only stripped non-digits. `0123 456 7890` became `01234567890`, producing a JID that is either undeliverable or — worse — belongs to someone else. Real normalization needs a default region.

**Decision: default to the device's SIM region, user-overridable in settings.**

There is no first-party Capacitor API for SIM country. Either add a small custom plugin wrapping `TelephonyManager.getSimCountryIso()`, or fall back to the locale region from `@capacitor/device`'s `getLanguageTag()`. Either way the value is a *default* that the user can change, and it is persisted per user.

```typescript
import { Contacts } from '@capacitor-community/contacts';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export interface NormalizedContact {
  id: string;
  displayName: string;
  e164: string;          // '+201234567890'
  jid: string;           // '201234567890@s.whatsapp.net'
}

export async function fetchLocalContacts(defaultRegion: CountryCode) {
  let perm = await Contacts.checkPermissions();
  if (perm.contacts !== 'granted') {
    perm = await Contacts.requestPermissions();
    if (perm.contacts !== 'granted') throw new Error('CONTACTS_PERMISSION_DENIED');
  }

  const { contacts } = await Contacts.getContacts({
    projection: { name: true, phones: true },
  });

  const usable: NormalizedContact[] = [];
  const needsReview: { id: string; displayName: string; raw: string }[] = [];

  for (const c of contacts ?? []) {
    const displayName = c.name?.display?.trim() || 'Unknown Contact';
    for (const phone of c.phones ?? []) {
      const raw = phone.number ?? '';
      const parsed = parsePhoneNumberFromString(raw, defaultRegion);
      if (parsed?.isValid()) {
        const e164 = parsed.number;                       // always '+<digits>'
        usable.push({
          id: `${c.contactId}:${e164}`,
          displayName,
          e164,
          jid: `${e164.slice(1)}@s.whatsapp.net`,         // strip the leading '+'
        });
      } else if (raw) {
        needsReview.push({ id: c.contactId, displayName, raw });
      }
    }
  }

  return { usable, needsReview };
}
```

Three corrections embodied above:

- Numbers that cannot be parsed go to a **`needsReview` bucket surfaced in the UI**, rather than being silently mangled into a plausible-looking wrong number. Sending to a wrong number is worse than not sending.
- **All** of a contact's numbers are considered, not just `phones[0]`. The user picks which one.
- `e164.slice(1)` removes the single leading `+`. The previous draft's `.replace('+','')` replaces only the first occurrence, which happens to be correct here but is fragile; `slice(1)` on a guaranteed-`+`-prefixed E.164 string is explicit.

### 7.3 Registration check before sending

Baileys exposes `sock.onWhatsApp(jid)` to test whether a number is registered. Run it before queueing. Sending to unregistered numbers wastes queue time and is itself a signal of automated bulk behaviour. Unregistered contacts resolve to `status = 'SKIPPED'` rather than `FAILED`.

### 7.4 Natural-language matching

`contactMatcher.ts` receives the user's query plus a **compact** contact index — display name, tags and notes from `contact_meta`, and last-contact timestamps derived from `message_history`. It does not receive raw phone numbers or full message bodies. It returns a ranked list of contact ids, which the UI presents for confirmation and deselection **before anything is queued**. A natural-language query must never trigger a send directly.

---

## 8. Image flow

1. **Create** — the user describes an image (`ImageGenProvider.generate`) or asks to find one (`ImageSearchProvider.search`, returning thumbnails to pick from). `core-server` performs the call.
2. **Store** — `core-server` uploads the bytes to `user-images/<jwt_user_id>/<sha256>.png`, creates or updates the `image_sessions` row, and returns the object path plus a short-TTL signed URL. The client fetches it, renders it, and writes it to the local cache with an `image_cache` row.
3. **Refine** — the user adds free-text instructions ("make it more festive", "remove the text"). The client sends the instruction and session id; `core-server` loads the session's prompt history and current object, calls `edit()` or an amended `generate()`, stores the result as a new object, and advances `current_path`. Prior objects are retained until the session is discarded so the user can step back.
4. **Save to Photos (optional)** — `NativeBridge.saveImageToLibrary(bytes)`. On Android this must go through the MediaStore, not a plain file write: a file written to app-private or even external storage does not appear in Gallery apps without a MediaStore insert. Use `@capacitor/filesystem` together with a media plugin that performs the insert. On Android 9 and below this additionally requires `WRITE_EXTERNAL_STORAGE`; from Android 10 scoped storage removes that requirement.
5. **Send** — the chosen image plus selected contacts become a batch (§9). The WebView resolves the image from the local cache, downloading it once if absent, and passes the bytes to the Node process over IPC. The Node process never talks to Supabase.

---

## 9. WhatsApp delivery layer

### 9.1 Why there is no local HTTP server

The previous draft ran an Express server in the Node process on `localhost:3000` and asserted it "drops external packets automatically, ensuring zero network exposure to adjacent local networks."

**That claim was false, and it was the most serious problem in the document.** `app.listen(3000)` with no host argument binds to `0.0.0.0` — every interface. On a phone joined to Wi-Fi, anyone on that network could POST to `/api/v1/queue-batch` and send WhatsApp messages as the user, with no authentication of any kind. Binding to `127.0.0.1` would fix the network exposure but not the whole problem: **Android does not isolate loopback between apps**, so any other installed app holding `INTERNET` permission could still reach it.

Since the decision to keep storage out of the Node process removed the reason for an HTTP API in the first place, the server is deleted rather than patched. The WebView and the Node process communicate over the **`capacitor-nodejs` IPC bridge** (`NodeJS.send()` / `NodeJS.addListener()`), which is a process-to-process channel with no TCP socket and therefore no listening port to secure.

### 9.2 Durability boundary

A backgrounded WebView gets throttled — JS timers there are unreliable, so the pacing loop cannot live in the WebView. But storage now lives in the WebView. The split:

- **WebView owns durability.** Before any send is attempted it writes every recipient of the batch into `outbox` as `PENDING`, then hands the batch to Node over IPC.
- **Node owns pacing and sending.** It holds the batch in memory, sends sequentially, and emits a result event per recipient.
- **WebView persists each result**, updating `outbox` and mirroring to Supabase `message_history`, then deleting the settled `outbox` row.

If the process is killed mid-batch, the in-memory queue is lost but `outbox` still holds every unsettled row, so the batch resumes on next launch.

**Duplicate-send window:** a message whose result event never reaches the WebView before a kill will be retried. Mitigate by marking a row `CLAIMED` with `claimed_at` before handing it over, and on startup surfacing claimed-but-unsettled rows to the user as "may have been sent" rather than blindly resending. Silent retries of a message to a real person are worse than asking.

### 9.3 Node process — Baileys only

```javascript
// android/nodejs-assets/nodejs-project/main.js
const { default: makeWASocket, useMultiFileAuthState,
        fetchLatestBaileysVersion, DisconnectReason } = require('baileys');
const bridge = require('bridge');   // capacitor-nodejs IPC channel

let sock = null;
let ready = false;
let reconnectAttempts = 0;

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) bridge.send('wa:qr', qr);

    if (connection === 'open') {
      ready = true;
      reconnectAttempts = 0;
      bridge.send('wa:ready', {});
    }

    if (connection === 'close') {
      ready = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        bridge.send('wa:logged-out', {});   // needs a fresh QR pairing
        return;
      }
      // Every other close is transient — reconnect with backoff.
      const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts++);
      setTimeout(() => initWhatsApp().catch(reportFatal), delay);
    }
  });
}

async function runBatch(batch) {
  for (const item of batch.items) {
    if (!ready) { await waitForReady(); }
    try {
      const content = item.mediaBytes
        ? { image: Buffer.from(item.mediaBytes, 'base64'), caption: item.body }
        : { text: item.body };
      await sock.sendMessage(item.jid, content);
      bridge.send('wa:result', { id: item.id, status: 'SENT' });
    } catch (err) {
      bridge.send('wa:result', { id: item.id, status: 'FAILED', error: String(err) });
    }
    await sleep(randomInterval());   // §9.4
  }
  bridge.send('wa:batch-done', { batchId: batch.batchId });
}

bridge.on('wa:send-batch', (batch) => runBatch(batch).catch(reportFatal));
initWhatsApp().catch(reportFatal);
```

Corrections against the previous draft embodied here:

- **Reconnection is handled.** The previous version had no `connection === 'close'` branch at all, so the socket died permanently on the first network blip and the queue would stall forever. This is the single biggest functional bug in the old document.
- **`printQRInTerminal` removed** — deprecated in current Baileys, and redundant since the `qr` field of `connection.update` is already being handled.
- **QR is actually delivered.** The previous draft assigned the QR string to `app.locals.latestQR` with a comment saying it was exposed to the UI, but defined no route that ever read it. The UI could never have displayed a QR code.
- **Package name:** published as `baileys` on npm; `@whiskeysockets/baileys` is the older name. Confirm the current package and version at implementation time — this library moves fast and its API has broken between minors.
- **`fetchLatestBaileysVersion()`** pins the protocol version the socket advertises, which reduces spurious disconnects.

### 9.4 Pacing

Sends are sequential with a randomized interval between them (the previous draft used 7–18 seconds). Treat this as ordinary rate limiting for a batch job: WhatsApp is a shared service with limits, and firing a hundred messages back to back degrades it for everyone and will get the number blocked.

The previous draft framed this as defeating "automated fraud prevention systems." That framing should not guide implementation. The practical reasons for pacing are the same either way, but the product should be built for sending to people who expect to hear from the user — see §12.

### 9.5 Queue correctness issues carried over from the previous draft

Fixed by the §9.2 design, but recorded so they are not reintroduced:

- `SELECT ... LIMIT 1` with **no `ORDER BY`** gives no ordering guarantee.
- The row was only marked `SUCCESS` **after** the send returned, with no intermediate claimed state — so an app kill mid-send left the row `PENDING` and it was re-sent on restart. A real person receives the message twice.
- The batch insert loop had **no transaction wrapper**, so a large batch ran as N implicit transactions and a partial failure left half a batch queued.
- `res.json({ success: true })` was returned **before** the inserts completed, so the client was told a batch succeeded that might not have been written.
- `templateMessage.replace('{name}', ...)` with a string first argument replaces only the **first** occurrence. A template using `{name}` twice renders the literal `{name}` the second time. Use `replaceAll` or `/\{name\}/g`.

---

## 10. Android platform requirements

### 10.1 Manifest

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.READ_CONTACTS" />
    <!-- Never used: the app reads the address book and never writes back (§7.1).
         It is declared because @capacitor-community/contacts groups READ and
         WRITE under one "contacts" permission alias, and Capacitor refuses the
         alias request unless every permission in it is in the manifest. Removing
         it breaks contact import. It is also the permission a Play reviewer is
         most likely to ask about, so the reason is recorded here rather than
         only in a manifest comment. Verified against the plugin source
         (ContactsPlugin.java: @Permission(strings = { READ_CONTACTS,
         WRITE_CONTACTS }, alias = "contacts")) on 2026-09-19. -->
    <uses-permission android:name="android.permission.WRITE_CONTACTS" />
    <uses-permission android:name="android.permission.INTERNET" />

    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <!-- Required from API 34 (Android 14) alongside foregroundServiceType="dataSync" -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <!-- Required from API 33 (Android 13) to show the foreground service notification -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <!-- Play Store: this is a restricted permission requiring a policy exemption.
         Omit it for a Play build unless the exemption is granted. -->
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

    <application>
        <service
            android:name="com.crmex.gateway.BackgroundEngineService"
            android:foregroundServiceType="dataSync"
            android:enabled="true"
            android:exported="false" />
    </application>
</manifest>
```

The previous draft was missing `FOREGROUND_SERVICE_DATA_SYNC` and `POST_NOTIFICATIONS`. Both are hard requirements on current Android versions: without the former the service throws on start at API 34+, without the latter the notification is suppressed at API 33+. The test device is Android 10 (API 29) so neither bites during early development — but `targetSdk` governs which rules apply, and Play requires a recent `targetSdk`.

The manifest also declared the service without anything in the document ever starting it or connecting it to the Node process lifecycle. The service must be started when a batch begins and stopped when the queue drains.

### 10.2 Background execution reality

The previous draft claimed the foreground service "forc[es] the OS to whitelist the Node execution daemon even during strict sleep mode patterns." This overstates what a foreground service does.

- A foreground service **resists** Doze and app standby. It does not make the process unkillable.
- Android 14 caps `dataSync` foreground services at roughly **6 hours per 24**, after which the system calls `Service.onTimeout()` and the service must stop. Long batches must be designed to survive being stopped and resumed, which the `outbox` design (§9.2) already handles.
- **OEM battery managers are more aggressive than stock Android, and Huawei/EMUI is among the worst.** The test device is a Huawei P30 Pro. Expect the process to be killed unless the app is manually added to Huawei's protected-apps list. The app should detect a likely-throttled state and prompt the user to whitelist it, rather than silently stalling.

### 10.3 Distribution

Documented for both paths, since this is undecided:

| | Sideload / internal | Google Play |
| :--- | :--- | :--- |
| `targetSdk` | Free to lag | Must track Play's current minimum |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Usable freely | Restricted; needs a granted exemption or the app is rejected |
| Policy risk | None | **Material.** Play policy is hostile to apps automating WhatsApp or facilitating bulk unsolicited messaging. This is a listing risk independent of code quality. |
| APK size | Unconstrained | nodejs-mobile adds substantial size per ABI; use split APKs / App Bundle |

If Play is chosen, resolve the policy question before building, not after.

### 10.4 nodejs-mobile risk

Embedding Node on Android is the riskiest dependency in the design. Native Node modules must be compiled per Android ABI, which is where most nodejs-mobile projects stall. **Dropping `sqlite3` from the Node process (§3.2) removes the main instance of this problem** — the Node payload's only substantial dependency is now Baileys.

This must still be validated early: build the Node payload with Baileys for `arm64-v8a` and confirm the socket connects on the physical device **before** any UI work. If it fails, the fallback is to reimplement the WhatsApp transport natively or reconsider the embedded-Node approach entirely — a finding that would invalidate large parts of this document, so it belongs first in the build order.

---

## 11. Cross-platform reuse

`shared-ui/` holds the feature components — contact search, image canvas with refine prompt bar, send confirmation, progress — as plain React with no platform-specific imports. They reach the outside world through exactly two seams:

```typescript
// Everything server-side goes through one client, which attaches the Supabase JWT.
export interface ApiClient {
  matchContacts(query: string, index: ContactIndexEntry[]): Promise<string[]>;
  generateImage(prompt: string): Promise<Blob>;
  refineImage(sessionId: string, instruction: string): Promise<Blob>;
  searchImages(query: string): Promise<ImageResult[]>;
}

// Everything platform-specific goes through one bridge.
export interface NativeBridge {
  listContacts(): Promise<{ usable: NormalizedContact[]; needsReview: unknown[] }>;
  saveImageToLibrary(bytes: Blob): Promise<void>;
  signInWithGoogle(): Promise<{ idToken: string }>;
  sendBatch(batch: OutboxBatch): Promise<void>;
  storage: LocalStore;         // SQLite on device, IndexedDB in browser
}
```

Each shell supplies its own `NativeBridge`:

- **Android** — Capacitor plugins; `sendBatch` goes over the Node IPC bridge.
- **Browser** — contacts and WhatsApp sending are unavailable; those capabilities report unsupported and the UI hides them. It is a full client for everything else: because images live in Storage rather than on one device, the browser can generate, refine, and view complete image and send history. What it cannot do is read the device address book or hold a paired WhatsApp socket, and those are inherent limits rather than unimplemented work.
- **Electron (future)** — native save dialog via IPC; could host the Baileys socket in the Electron main process, making it a fuller client than the browser.

Because sending is Android-only, `web-ui` and `electron-shell` are genuinely secondary. The seam exists so they are cheap to add, not because they will reach feature parity.

---

## 12. Consent and intended use

Not addressed in the previous draft, and it shapes the product more than any technical decision here.

This app sends messages to people. The design should assume recipients are the user's own customers or contacts who expect to hear from them, and should make that the path of least resistance:

- **Consent is opt-out, with one flag per client (decided 2026-09-17).** Every client can be messaged by default. `clients.suppressed_at` (the "Opted out" switch on the client page) is that flag. It controls **every** message to the client: manual sends, browser-queued `send_jobs` (§15.10) and scheduled messages such as birthday greetings and hearing reminders (§16.7). An opted-out client is never queued again and is re-checked at claim time. Opting out also cancels the client's pending scheduled messages.
- **`clients.status` is a separate axis** (§18.3.1). An inactive or archived client is not messaged either, but that is the firm's filing decision, not the person's instruction — reactivating a client never clears an opt-out.
- `clients.opted_in_at` stays as an informational record of how and when consent was given. **It does not gate sending anywhere.**
- Surface batch size prominently before sending. A confirmation step that shows "this will message 340 people" is the cheapest guard against an accidental mass send.

---

## 13. Admin portal (design only — not in the build scope)

Operator-facing web app for the settings that must not be hard-coded: retention, quotas, provider selection, and user administration. Specified here so the enforcement points exist in the application from the start; **not implemented in the current phase.**

### 13.1 Who is an admin

Roles come from Supabase's `app_metadata.role` claim.

**Never put the role in `user_metadata`** — that field is writable by the user who owns the session, so a role stored there can be self-assigned by anyone with an account. `app_metadata` is writable only by the service role, which makes it a safe carrier for privilege. `core-server` reads the role from the verified JWT and must re-check it on every admin route, not once at login.

Two roles are enough: `user` (default, implicit) and `admin`. There is no self-service path to `admin`; it is granted out of band.

### 13.2 Scope: system configuration only

**The portal configures the system. It does not observe users.**

There is no screen, route, or query in the portal that returns anything about a user's communications or content. Specifically out of scope, permanently:

- Message bodies, captions, and send history
- Image content, thumbnails, and signed URLs
- Prompt text and refinement history
- Contact names, phone numbers, and JIDs
- Per-user activity of any kind — including counts, volumes, storage consumed, and last-active timestamps
- Any listing of user accounts — **amended by §15.8**: the tenant directory (firms and their members, no data) is visible to the operator

There is no break-glass content-access flow. A capability that exists is a capability that gets used; the way to guarantee operators cannot read user communications is for the code path not to exist.

What the portal does reach is platform-wide operational state that is not attributable to any user: total storage consumed, provider connectivity and error rates, retention job outcomes, and the portal's own audit log. These are needed to keep the service running and reveal nothing about who sent what to whom.

This is stricter than §4. §4 keeps users from seeing each other; §13.2 keeps the operator from seeing any of them.

**Accepted consequence:** there is no per-user support or abuse-response capability in the portal. If one account exhausts provider budget or is reported for abuse, there is no portal lever to inspect or restrain it — only global settings that affect everyone. That is a real gap, recorded in §14 rather than quietly solved by adding a users screen.

### 13.3 Settings model

Settings are global. There are no per-user overrides, because managing one would require the portal to enumerate users.

```sql
-- Global settings. Keyed rows rather than one column per setting, so adding a
-- setting is a migration-free insert.
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

-- Every admin mutation, append-only. Configuration changes only — there are no
-- user-targeted admin actions, so there is no target_user column.
create table admin_audit_log (
  id           bigserial primary key,
  actor_id     uuid not null references auth.users(id),
  action       text not null,          -- 'settings.update' | 'retention.run' | ...
  setting_key  text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);

alter table app_settings    enable row level security;
alter table admin_audit_log enable row level security;
```

Quota enforcement still needs counters, and those are per-user by nature:

```sql
create table usage_daily (
  user_id           uuid not null references auth.users(id) on delete cascade,
  day               date not null,
  images_generated  integer not null default 0,
  messages_sent     integer not null default 0,
  storage_bytes     bigint  not null default 0,
  primary key (user_id, day)
);

alter table usage_daily enable row level security;
```

`usage_daily` exists **solely so `core-server` can enforce quotas at request time**. It is not exposed through any admin route, and the portal has no query against it that is not a platform-wide `sum()`. Writing a per-user read of this table into an admin endpoint would defeat §13.2.

All three tables have RLS enabled with no policies, so the default is deny. Only `core-server` reaches them, via the service role, after verifying the admin claim on the route.

Initial `app_settings` keys:

| Key | Meaning |
| :--- | :--- |
| `retention.unsent_image_ttl_days` | Delete images from sessions that were discarded without sending |
| `retention.sent_image_ttl_days` | Delete images that were sent, after N days (`0` = keep indefinitely) |
| `quota.default_daily_images` | Generation cap per user per day |
| `quota.default_storage_bytes` | Storage ceiling per user |
| `limits.max_batch_recipients` | Hard cap on recipients in one send |
| `pacing.min_interval_ms` / `pacing.max_interval_ms` | Send pacing window (§9.4) |
| `providers.llm` / `providers.image_gen` / `providers.image_search` | Which adapter is active — **names only, never keys** |
| `features.image_search_enabled` | Kill switch for a capability |

### 13.4 Secrets stay out of the portal

The portal selects *which* provider is active. It never stores, displays, or accepts provider API keys.

Keys live in the deployment's secret manager (environment configuration, or Supabase Vault) and are read by `core-server` at startup. A portal that can display a key turns every admin session, and every XSS bug in the portal, into a credential compromise. The provider screen shows the adapter name, a connectivity health check, and recent error rates — never the secret.

### 13.5 Enforcement lives in core-server, not the portal

The portal writes values. `core-server` enforces them, on every request, from the JWT-derived `user_id`:

- Before generation: check `usage_daily.images_generated` against `quota.default_daily_images`, and `storage_bytes` against `quota.default_storage_bytes`. Reject with a quota error the client can render meaningfully.
- Before queueing a batch: check recipient count against `limits.max_batch_recipients`.
- After each operation: increment `usage_daily`.

A client that never calls the portal must still be fully constrained. Treat the portal as a way to change numbers, never as the thing that applies them.

### 13.6 Retention job

Retention is a scheduled server-side job, not a portal button — though the portal should be able to trigger a run and preview what a run would delete before it happens.

- Selects `image_sessions` and Storage objects past their TTL, deletes the objects, then the rows.
- **Devices may hold cached copies of deleted images.** Cache invalidation is lazy: a download that 404s drops the local `image_cache` row and the file. Do not attempt to push deletions to devices.
- Deleting an image referenced by `message_history` must not delete the history row. History keeps `media_sha256` and renders a "no longer stored" placeholder — the record that something was sent outlives the file.

### 13.7 Screens

Five screens. There is no users screen, by §13.2.

| Screen | Contents |
| :--- | :--- |
| **System health** | Platform-wide totals only: storage consumed, generation and send volume, failure rate, estimated provider cost over time. No per-user breakdown and no drill-down — these are `sum()` queries with no user dimension. |
| **Limits & quotas** | The global values in `app_settings` |
| **Retention** | TTL policy, platform storage totals, dry-run preview (object and byte counts, not a file listing), manual run trigger |
| **Providers** | Active adapter per capability, connectivity health check, error rates. No keys. |
| **Audit log** | Read-only record of configuration changes, filterable by actor and action. Cannot be edited or deleted from the portal. |

The retention dry-run is the one screen where this boundary could erode: a preview that listed the objects it would delete would expose per-user storage paths. It returns counts and totals only.

### 13.8 Deployment — web only

**The portal is a web application and exists nowhere else.** It is never compiled into the Android APK and never bundled into the Electron shell.

The reason is that both of those are distributed binaries. Anything inside them is in the user's possession: it can be unpacked, inspected, and modified, and any client-side role check in them can be patched out. A server-side check on `/api/v1/admin/*` would still hold, but shipping admin screens and route names to every user hands out a map of the control surface for no benefit — nobody administers the system from a phone.

Concretely:

- `admin-ui` is a **separate build and a separate host** from `web-ui`, not a route inside it and not a conditional branch behind a role flag.
- It should be network-restricted where practical — an internal host, an allowlist, or an access proxy in front of it.
- Admin routes live under `/api/v1/admin/*` behind role-checking middleware **distinct from** the normal user middleware, so a missing check on a user route can never expose an admin capability, and the admin middleware has one job that is easy to audit.
- `shared-ui` is not shared with `admin-ui`. They have no components in common worth the coupling, and keeping them separate means no admin code can reach a client bundle by accident through a shared import.

## 14. Open items


- **Which concrete providers** to implement first behind the LLM, image-gen and image-search interfaces. Needs accounts and API keys before implementation starts.
- **Play Store vs sideload** (§10.3), including the policy question if Play is chosen.
- **Starting values** for the quota, retention and pacing settings in §13.3. The mechanism is designed; the numbers are not chosen. Sensible defaults must ship with the enforcement code, because the admin portal is not being built in this phase and the settings table needs seeding either way.
- **No per-user operational lever** (§13.2). Because the portal deliberately cannot see or act on individual accounts, there is no way to respond to a single user exhausting provider budget or being reported for abuse — only global settings that affect everyone. If that becomes necessary, it needs a deliberate decision about the minimum visibility required, not an incremental relaxation of §13.2.
- **Contact index privacy** — how much contact metadata is acceptable to send to a third-party LLM for matching. Consider a local heuristic first, escalating to the LLM only for queries it cannot resolve.
- **SIM region detection** (§7.2) — needs either a small custom Capacitor plugin or an accepted fallback to locale.

---

## 15. Multi-tenancy — firms as tenants

CRMEX is a multi-tenant SaaS for law firms. A **firm** (`organizations` row) is the tenant: its members share the firm's clients, matters, tasks and message history, and no data ever crosses between firms. This replaces "per-user isolation" (§4) as the boundary for CRM data. It is the highest-risk change in the system — a tenancy bug leaks privileged client information between law firms — so it is enforced in three independent places (§15.4) and covered by its own test suite (§15.9).

### 15.1 Concepts

| Concept | Meaning |
| :--- | :--- |
| Firm (`organizations`) | The tenant and the billing unit. Has a name, a plan, and members. |
| Member (`org_members`) | A user's membership of a firm, with a role. A user may belong to several firms; the app works in one **active firm** at a time. |
| Role | `owner` (billing, delete firm, manage admins), `admin` (invite/remove members, firm settings), `member` (work with CRM data). Stored on the membership row, **never** in `user_metadata` (§13.1 applies: the user can write that). |
| Invitation (`org_invitations`) | Email + role + single-use token, expiring. Accepting creates the membership for the signed-in user whose verified email matches. |

Platform roles (`app_metadata.role = 'admin'`, §13.1) are unrelated to firm roles. A platform admin has **no** implicit access to any firm's data.

### 15.2 Onboarding

1. First sign-in with no membership → "Create your firm" (firm name) → the user becomes `owner`. Creation runs through `core-server` (service role) so the first membership can be inserted atomically with the firm; clients cannot insert `org_members` rows for themselves.
2. Or the user joins by invitation. An owner/admin creates one in the app, which shows it as a **QR code** (scanned by the invitee in the app) and as a link that can be **emailed** (device mail composer for now; server-side email later). The invitation carries a single-use token; accepting it creates the membership for the signed-in user, and an email-addressed invitation only accepts for a user whose verified email matches.
3. Firm switcher in the avatar menu when the user has more than one membership. The active firm id is kept on the device (Preferences) and re-validated against the membership list on every launch.

### 15.3 Data model

Every firm-owned table carries `org_id uuid not null references organizations(id) on delete cascade` plus `created_by uuid references auth.users(id)`, and an index leading with `org_id`.

| Table | Scope | Notes |
| :--- | :--- | :--- |
| `organizations` | firm | `id, name, plan, created_at`. `plan` writable only by the service role. |
| `org_members` | firm | `(org_id, user_id)` unique, `role`, `created_at`. |
| `org_invitations` | firm | `org_id, email, role, token_hash, expires_at, accepted_at`. Store a hash of the token, never the token. |
| `clients` | firm | CRM contact record: `display_name, phone_e164, email, kind` (`client` / `prospect` / `opposing_counsel` / `court` / `other`), `tags text[]`, `notes`, `opted_in_at` (informational only), `suppressed_at` (the client-level opt-out that controls all messaging, §12), `source` (`manual` / `phone_import`), `status` (`active` / `inactive` / `archived`, the CRM lifecycle flag from §18.3.1 — not a consent field), and, from §16, `birth_date` and `timezone`. `unique (org_id, phone_e164)` where phone is set. Replaces `contact_meta` (§12's consent fields live here). |
| `matters` | firm | `matter_number` (unique per firm), `title, practice_area, status` (`open` / `pending` / `closed`), `opened_at, closed_at, notes`. |
| `matter_clients` | firm | Join: `matter_id, client_id, role` (`client` / `opposing_party` / `witness` / …). |
| `tasks` | firm | `title, notes, due_at, kind` (`task` / `deadline` / `hearing`), `status` (`open` / `done`), `matter_id` (nullable), `assignee_id` (member). |
| `message_history` | firm | Gains `org_id` and `client_id` (nullable); `user_id` becomes "sent by". |
| `image_sessions` | firm | Gains `org_id`. |
| `usage_daily` | firm | Keyed `(org_id, day)` for firm-level quotas and billing; per-user counters are not needed for billing. |

Device-local SQLite (`outbox`, `image_cache`) stays keyed by `user_id` **and** records `org_id`, so switching firms never replays another firm's outbox (§4 "Device SQLite" rule extends to `org_id`).

WhatsApp pairing stays per device and per user (§3.4). A firm does not share one WhatsApp number through this app.

### 15.4 Enforcement — three independent layers

1. **RLS on every firm table**, via two `security definer` helpers with a pinned `search_path`:
   `is_org_member(org uuid) returns boolean` and `has_org_role(org uuid, roles text[]) returns boolean`, both reading `org_members where user_id = auth.uid()`. Policies are `using (is_org_member(org_id)) with check (is_org_member(org_id))`; member management requires `has_org_role(org_id, '{owner,admin}')`. The helpers exist to avoid recursive RLS on `org_members` itself.
2. **`core-server`** (service role, bypasses RLS): every route that touches firm data reads the active firm from an `X-Org-Id` header, **looks up the caller's membership from the database** using the JWT-derived `user_id`, and rejects with 403 if absent. The header is a selector, never an authority. Every repository query filters by the verified `org_id`.
3. **Storage paths** become `<org_id>/<user_id>/<sha256>.png`, constructed server-side from the verified membership. Folder-prefix policies check `is_org_member(((storage.foldername(name))[1])::uuid)`.

The existing §4 rules (no client-supplied ids in paths, short-TTL signed URLs, no prompt-only caches) apply unchanged, with `org_id` added to cache keys.

### 15.5 What members can see of each other

Inside a firm, members see all clients, matters, tasks and message history — that is the point of a shared CRM. Members see each other's name and email (to assign tasks). Nothing else about a member is exposed.

### 15.6 Offboarding

Removing a member deletes the membership; their RLS access ends on their next request (tokens are re-checked against `org_members`, not cached). Records they created stay with the firm (`created_by` is kept for attribution; `on delete set null` if the user account is deleted). The same applies to `message_history.user_id`, `image_sessions.user_id`, `contact_meta.user_id` and `send_jobs.created_by`: deleting an account nulls them and the firm keeps the rows; a `send_jobs` row whose creator is gone can no longer be claimed, cancelled or finished by anyone. The removed user's device purges the firm's local cache on next launch when the membership check fails. An owner cannot remove the last owner.

### 15.7 Audit

`org_audit_log (org_id, actor_id, action, entity, entity_id, created_at)` for membership changes, client/matter deletion, and exports. Visible to firm owners/admins only. Records **who did what**, never field contents.

### 15.8 SaaS operator boundary

Decided 2026-09-13, amending §13.2: the operator (platform admin) **may see the tenant directory** — firms (name, plan, created date, seat count) and each firm's members (name, email, role, joined date). This is needed to run a SaaS (support, billing, abuse response at the firm level). The operator **never** sees firm data: clients, matters, tasks, message bodies or history, images, prompts, or any per-member activity or counts. The directory is exposed only through admin routes behind the §13.1 platform-role check, and every directory read is written to `admin_audit_log`.

### 15.9 Tests (to add to `test-plan.md`)

The isolation suite gains a firm axis: two firms (Firm A with users A1/A2, Firm B with user B1). Every firm table and every `core-server` route must show A1 and A2 sharing data, B1 seeing none of it via RLS, via `core-server` with a forged `X-Org-Id`, and via Storage paths; plus removal (A2 loses access immediately) and role checks (a `member` cannot invite or remove).

### 15.10 Browser client and phone-dispatched sending

Decided 2026-09-13. The same app runs in a browser (`web-ui`, a thin Vite shell over the shared app in `shared-ui`, per §11). A browser user can do everything a phone user can — clients, matters, tasks, composing, AI drafting/images, recipient selection, review, history — except hold the WhatsApp session, which stays on the user's own phone (§3.4, §9).

**Sending from the browser queues a job; the user's own phone sends it.**

- `send_jobs` (firm-scoped): `id uuid` (also used as the `batch_id` of the resulting `message_history` rows), `org_id`, `created_by` (the sender — only this user's phone may run the job, because it is their WhatsApp account), `status` (`queued` → `claimed` → `done`, or `cancelled` / `failed`), `body`, `media_path`, `recipients jsonb` (`[{client_id, jid, display_name}]`, validated against the firm's clients at queue time), `claimed_at`, `finished_at`, `error`, timestamps.
- RLS: firm members may read the firm's jobs; insert only with `created_by = auth.uid()`; status changes only by `created_by` (their phone claims/finishes, their browser cancels a still-`queued` job).
- The phone app subscribes (Supabase Realtime) while running, and also checks on launch/resume. It **claims atomically** (`update … set status='claimed' where id=… and status='queued' and created_by=auth.uid()` returning the row) so two devices can never both send a job, then runs it through the normal durable path (§9.2 outbox → Node → mirror), then marks it `done`.
- Suppression (the client-level opt-out, §12) and the batch-size limit are re-checked on the phone at claim time, not just when the browser queued it (a client may have opted out in between).
- Scheduled client messages (§16.7) arrive through the same table. §16.4.1 adds `expires_at` (the phone never claims a job past it), `source_reminder_id`, and the `queued → expired` transition.
- The browser shows the job's live status and per-recipient results as the phone mirrors them into `message_history`.
- **Accepted limitation:** a job only runs while the phone app is alive and allowed to run in the background (Huawei EMUI kills it aggressively, §10.2). No push wake-up (FCM) in this phase; the browser tells the user their phone must be online with CRMEX open.
- The browser never talks to WhatsApp and the server never holds a WhatsApp session.

Browser-specific platform differences: Google sign-in via `supabase.auth.signInWithOAuth` redirect; preferences in `localStorage`; no phone-contacts import, no QR scanning (invites accepted by link `/invite/<token>` or pasted code), no hardware back. Runs locally for now (Vite dev server); hosting is decided later. `core-server` CORS must allow the web origin (`CORS_ALLOWED_ORIGINS`), and Supabase Auth must list the web app's redirect URL.

---

## 16. Scheduling, processes and reminders

**Status: designed 2026-09-17, under review; not implemented and not yet in the `PLAN.md` build order.** The open decisions are in §16.13. Test cases: `test-plan.md` §19 (`SCH-*`).

`PLAN.md` §3 lists "campaign scheduling", "calendar sync" and "push reminders" as out of scope. This section brings the first and third back into scope once approved (decision D8).

### 16.1 What problem this solves

Law firm work follows **procedures with fixed gaps between steps**: a divorce, for example, goes file petition → serve → wait N days → first hearing → … . Some dates are **set by someone else** (the court) and **booking them takes a long lead time**. Missing one can push the case back by months. Firms also have **client-relationship dates** (birthdays, anniversaries of a case closing) when they want to contact the client.

So the system needs to:

1. **Create a matter's whole timeline in one step** from a template, with reminders already attached, so nobody has to remember to add them.
2. **Tell the right person early enough to act**, including "book the court date now" reminders weeks before the hearing itself.
3. **Let people move dates**, and when a date moves, move the steps that depend on it (with a preview first) without silently moving dates the court has already fixed.
4. **Make missed dates impossible to miss.** An event that passes without being marked done gets escalated. It doesn't just sit there.
5. **Send client messages at the right time** (e.g. 09:00 on the client's birthday) over the existing WhatsApp path.

Two kinds of notification come out of this, and they work very differently:

| | Staff reminders | Client messages |
| :--- | :--- | :--- |
| Recipient | Firm members (assignee, matter team) | The firm's client |
| Channel | In-app inbox, device notification, (later) email/push | WhatsApp, via the sender's own phone (§15.10) |
| Duplicates | Tolerable (at-least-once) | Not acceptable (at-most-once) |
| Late delivery | Better late than never, marked "late" | Stops being useful after a window (a birthday message 3 days late is worse than none) |
| Consent | n/a | Opt-out, one flag per client: sent by default, never sent once the client is opted out (`clients.suppressed_at`, the existing "Opted out" switch). Opt-in is not required. |

---

### 16.2 Concepts

| Concept | Meaning |
| :--- | :--- |
| **Process template** | A firm-authored procedure, e.g. "Uncontested divorce". A list of **steps**, each placed relative to the process start or to another step, each with default **reminder rules**. |
| **Process** (instance) | A template applied to one matter with a start date. Creating it creates the events and their reminders. |
| **Event** | Anything with a date that appears on a calendar: hearing, court visit, filing deadline, client call, meeting, booking deadline, client message. May belong to a process, a matter, a client, or none of these. |
| **Reminder** | A notification attached to an event, set relative to the event's start ("7 days before at 08:00", "2 hours before"). Its fire time is **derived**: when the event moves, the reminder moves with it. |
| **Date source** | Where an event's date came from: `projected` (calculated from the template), `manual` (a person set it), or `fixed` (set externally, e.g. by the court). Only `projected` dates move automatically when an earlier step moves. |
| **Calendar** | A view, not a stored object. "My calendar" means events assigned to me, "Firm calendar" means all of the firm's events, "Matter timeline" means one matter's events. |

---

### 16.3 Worked example

The numbers are **placeholders**. Real gaps depend on the jurisdiction, and each firm enters its own.

Template **"Divorce — contested"**, anchor label *"Instruction received"*:

| Step key | Title | Kind | Placed at | Date source on creation | Reminders (staff unless noted) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `start` | Instruction received | milestone | anchor | manual | — |
| `petition` | File petition | filing | `start` + 14 days | projected | 3 days before 09:00; on the day 09:00 |
| `book_h1` | **Book first hearing slot** | booking | `hearing1` − 8 weeks | projected | 7 days before; on the day; **escalate to matter lead if not done 2 days after** |
| `hearing1` | First hearing | hearing, 09:30, 2h | `petition` + 12 weeks | projected, **needs confirmation** | 14 days before; 1 day before 17:00; 2 hours before. Client (WhatsApp, approve first): 1 day before 10:00 "Reminder: your hearing is tomorrow at …" |
| `call_prep` | Prep call with client | call | `hearing1` − 5 days | projected | on the day 09:00 |
| `hearing2` | Second hearing | hearing | `hearing1` + 16 weeks | projected, needs confirmation | same as `hearing1` |

A lawyer opens matter 2026-014, taps **Apply process → Divorce — contested**, and sets the start to 2026-09-20. The system creates 6 events and 14 reminders, and shows the timeline. When the court later confirms the first hearing for 2026-12-22 instead of the projected 2026-12-27, the lawyer moves `hearing1` and marks it **fixed**. The preview shows `call_prep` and `hearing2` moving with it and `book_h1` moving earlier. `book_h1` is already done, so it stays where it is.

Birthday: client Fatma has `birth_date = 1980-03-14`. Her agent adds a **Birthday** event (yearly) with a client message at 09:00 on the day and a staff reminder 3 days before. On 2027-03-11 the agent gets "Fatma's birthday on Sunday, message scheduled". On 2027-03-14 at 09:00 the message goes out (§16.7). Then the next year's occurrence is created.

---

### 16.4 Data model

All tables follow the §15 conventions already used by `crm_core.sql`:

- `org_id not null`, RLS through `is_org_member` / `has_org_role`
- composite FKs on `(id, org_id)` so no link can cross firms
- `guard_org_id`, `guard_created_by` and `set_updated_at` triggers
- `created_by` set from `auth.uid()`
- explicit grants, and none for `anon`

#### 16.4.1 Changes to existing tables

| Table | Change | Why |
| :--- | :--- | :--- |
| `organizations` | `timezone text not null default 'UTC'` (IANA name, validated) | "09:00 on the birthday" and "all-day on 22 Dec" need one timezone the server agrees with. Today `tasks` uses the device's local time, which breaks as soon as a server does the scheduling. |
| `clients` | `birth_date date`, `timezone text` (nullable, defaults to the firm's) | Birthday events; client messages go out at the client's local morning. No new consent column: the existing `suppressed_at` ("Opted out") controls every message to the client, scheduled or not. |
| `send_jobs` | `expires_at timestamptz`, `source_reminder_id uuid`, new status `expired` (`queued → expired`) | A scheduled client message must not go out after its window. The phone refuses to claim past `expires_at`. |

#### 16.4.2 Templates (firm-authored, owner/admin write, members read)

```text
process_templates
  id, org_id, created_by
  name, practice_area, description
  anchor_label            -- "Instruction received"
  status                  -- draft | active | archived
  version int             -- bumped on each publish
  timestamps

template_steps
  id, org_id, template_id
  step_key                -- unique per template, e.g. 'hearing1'
  title, kind, instructions
  anchor_step_key         -- null = process start; must form a DAG (validated)
  offset_value int        -- may be negative (book_h1 = hearing1 − 8 weeks)
  offset_unit             -- days | weeks | months   (business_days: §16.11)
  start_time time         -- null = all-day
  duration_minutes int
  needs_confirmation bool -- externally set date; created 'tentative'
  assignee_rule           -- matter_lead | process_creator | unassigned
  sort_order

template_reminders
  id, org_id, step_id
  lead_days int, at_time time      -- "3 days before at 09:00"   } exactly one
  lead_minutes int                 -- "2 hours before"            } of these
  audience                -- assignee | matter_team | firm_admins | client
  body_template           -- '{client_name}', '{event_time}' … ; rendered with replaceAll (§9.5)
  requires_approval bool  -- client audience only
  escalate_if_not_done bool  -- fires only if the event is still open
```

`kind` values: `milestone, hearing, court_visit, filing, deadline, booking, call, meeting, client_message, occasion, other`.

#### 16.4.3 Instances

```text
matter_processes
  id, org_id, matter_id (composite FK), created_by
  template_id (nullable, on delete set null)
  template_name, template_version   -- snapshot for display
  start_date date
  status                  -- active | paused | completed | cancelled
  timestamps

events
  id, org_id, created_by
  title, notes, location, kind
  status                  -- tentative | scheduled | done | missed | cancelled
  -- Source of truth is local date/time + timezone; starts_at/ends_at are
  -- derived by trigger so DST and "all-day" are handled in one place.
  local_date date, local_time time (null = all-day), duration_minutes
  timezone text           -- copied from firm (or client for client occasions)
  starts_at, ends_at timestamptz   -- trigger-maintained, indexed
  date_source             -- projected | manual | fixed
  -- the placement rule is copied onto the event itself, so a live matter
  -- never changes because someone edited the template later
  process_id, step_key, anchor_event_id (same org), offset_value, offset_unit
  matter_id, client_id, assignee_id (must be a firm member; like tasks_check_assignee)
  recurrence              -- none | yearly
  recurrence_of uuid      -- previous occurrence
  completed_at, completed_by
  timestamps

event_reminders
  id, org_id, event_id, created_by
  lead_days / at_time / lead_minutes, audience, body_template,
  requires_approval, escalate_if_not_done       -- copied from template
  sender_id               -- client audience only: whose WhatsApp sends it
  fire_at timestamptz     -- trigger-maintained from the event
  status                  -- scheduled | claimed | sent | skipped | failed | cancelled
  claimed_at, sent_at, error, send_job_id
  generation int          -- bumped whenever fire_at changes (dedupe key, §16.6)

event_changes             -- visible firm history of date moves
  id, org_id, event_id, actor_id
  old_local_date, old_local_time, new_local_date, new_local_time
  cascade_root_event_id, reason, created_at

notifications             -- per-recipient in-app inbox
  id, org_id, user_id, event_id, reminder_id, generation
  kind                    -- reminder | escalation | moved | missed | approval_needed | late
  title, body, created_at, read_at
  unique (reminder_id, user_id, generation)
```

**RLS summary**

- **`process_templates`, `template_*`**: members select; owner/admin insert, update and delete.
- **`matter_processes`, `events`, `event_reminders`**: members select, insert and update. Delete is owner/admin only. Members **cancel** instead, because a deleted court date leaves no trace.
- **`event_reminders` with audience `client`**:
  - Insert or update only when `sender_id = auth.uid()`. This mirrors the `send_jobs` creator rule: only the sender's phone holds that WhatsApp account.
  - Other members can see these reminders and cancel them, but not re-point them.
- **`notifications`**: `user_id = auth.uid() and is_org_member(org_id)`. There is no insert policy; only the dispatcher (service role) writes. The user may update `read_at` only.
- **`event_changes`**: members select. Rows are written by the move function only, never updated or deleted.
- The operator (§15.8) sees none of these tables, not even counts.

---

### 16.5 Creating and moving dates

Both operations change many rows that have to stay consistent, and the phone and browser must compute them the same way. So they are **Postgres functions with `security invoker`**, so RLS still applies. They are called with `supabase.rpc(...)`, matching how the CRM already writes directly under RLS.

#### 16.5.1 `apply_process(matter_id, template_id, start_date)`

1. Load the active template. Check the steps form a DAG and resolve them in topological order.
2. Create the process and the `start` milestone event.
3. For each step, set `local_date = anchor.local_date + offset` (months are clamped to the end of the month).
   - `date_source = 'projected'`
   - `status = 'tentative'` if `needs_confirmation`, otherwise `'scheduled'`
   - Resolve the assignee from `assignee_rule`.
4. Copy the template's reminders onto each event. Client-audience reminders get `sender_id = auth.uid()`.
5. The triggers derive `starts_at` and `fire_at`.
6. Return the created timeline. If any step lands in the past, flag it in the result ("3 steps are already overdue") instead of failing.

#### 16.5.2 `preview_move(event_id, new_date, new_time)` → `apply_move(…, reason, expected_preview_hash)`

**Cascade rule.** Walk the dependents of the moved event (events whose `anchor_event_id` chain leads to it).

| Dependent is… | Result |
| :--- | :--- |
| `projected` and not done/cancelled | Moves: recalculated from its anchor's new date |
| `manual` or `fixed` | **Stays put**. If it now falls before its anchor plus offset, it is listed as a **conflict** |
| `done` / `cancelled` / `missed` | Never moves |

The moved event itself becomes `manual`, or `fixed` if the user ticks "this date is confirmed by the court". Confirming also turns `tentative` into `scheduled`.

**Preview then apply.** `preview_move` returns `[{event, old, new}]` plus conflicts and a hash of that result. `apply_move` recalculates and refuses if the hash differs, because someone else may have moved something in the meantime. It then applies everything in one transaction:

- writes `event_changes` rows
- the trigger recalculates each `fire_at` and bumps `generation`
- re-arms reminders whose new `fire_at` is in the future (`sent → scheduled`)
- cancels reminders now in the past that haven't fired, **except** that a reminder whose fire time moved into the past because the event moved *earlier* fires immediately, marked "moved"
- tells every affected assignee "Hearing moved from 27 Dec to 22 Dec by Omar"

A moved `booking` step that is now overdue shows up immediately as an escalation. This is the "we just lost our slot" case, and it has to be loud.

#### 16.5.3 Marking outcomes

- **Done**: sets `completed_at`/`completed_by` and cancels remaining escalation reminders. A yearly event creates its next occurrence, with the same reminders, at this point.
- **Missed** (manual, or prompted by §16.6.3): opens a "Reschedule" sheet. That is just `preview_move` from the missed event. The original is kept as `missed` for the record and a new event carries the new date. This is a special case of the move function, so dependents still cascade.
- **Cancelled**: all its reminders are cancelled. Dependents are listed but left alone.

---

### 16.6 Delivery — the dispatcher

A new `core-server` job (next to `jobs/retention.ts`). It uses the service role, so it follows the same rule as retention: **every query filters by `org_id` and resolves recipients from `org_members` at fire time**, never from anything a client supplied.

#### 16.6.1 Each tick (every 60 s)

```sql
update event_reminders set status = 'claimed', claimed_at = now()
where id in (select id from event_reminders
             where status = 'scheduled' and fire_at <= now()
             order by fire_at limit 200
             for update skip locked)
returning *;
```

For each claimed reminder, re-check against current data:

1. The event is not `cancelled`. For `escalate_if_not_done`, it is still open. The reminder's `generation` still matches, so the event hasn't moved since the claim.
2. Resolve the audience:
   - `assignee`: `events.assignee_id`
   - `matter_team`: members who created or are assigned events on the matter (until matters get an explicit team, §16.11)
   - `firm_admins`: owners and admins
   - Only **current** members count, so an offboarded member (§15.6) gets nothing.
3. **Staff audience**:
   - Insert `notifications` rows. The unique key makes a retry harmless.
   - Deliver to the configured external channel (§16.6.2).
   - Mark the reminder `sent`. If `fire_at` is more than 15 min old, the notification is marked **late**.
4. **Client audience**: see §16.7.

A claim left over from a crashed tick (`claimed` older than 5 min) goes back to `scheduled` for staff reminders. For client reminders, `send_job_id` decides: if the job was created, the reminder is marked `sent`; if not, it is re-queued.

#### 16.6.2 Staff channels and their honest limits

| Channel | Fires when the phone app is killed? | Fires when the phone is off/offline? | Status in this design |
| :--- | :--- | :--- | :--- |
| **In-app inbox** (Realtime + badge) | No; seen on next open | No | Phase 1 |
| **Device local notification.** The phone schedules OS alarms (`@capacitor/local-notifications`, already a dependency) for its user's reminders in the next 14 days, across all their firms. Resyncs on launch, resume, Realtime change and sign-in, and cancels all on sign-out. | **Usually yes.** Uses AlarmManager, not our process. EMUI may still suppress it unless the app is whitelisted (§10.2). | Yes, if synced before going offline | Phase 1 |
| **Email** from the dispatcher | Yes | Yes (arrives later) | Needs an email provider (open decision) |
| **FCM push** | Yes | Arrives on reconnect | Needs a Firebase project and a device-token table. Later. |

A missed court date is the failure being prevented, so **Don't call reminders "critical" in the product until at least one channel doesn't depend on the phone app** (email, or FCM). Phase 1's local notifications are good, but on Huawei they're best-effort.

Local notification and push content is **minimal by default** ("Hearing tomorrow 09:30 · Matter 2026-014"). Lock screens and third-party email servers are outside the firm's control, and client names in a family-law matter are privileged. A firm setting can allow names.

#### 16.6.3 Overdue sweep (same job, every 15 min)

- Events still `scheduled` more than 2 h after they end → notify the assignee: "Did *First hearing* happen?" with Done / Missed / Reschedule actions.
- Still open after 24 h → escalate to owners/admins and the matter's other assignees.
- `tentative` events within 30 days of their projected date that nobody has confirmed → "Hearing date not confirmed yet" to the assignee. This is the reminder that prevents losing a slot.

#### 16.6.4 Dispatcher downtime

When the job resumes, overdue staff reminders are delivered, marked late, **collapsed into one notification per user** if there are more than 5. Client reminders past their window are marked `skipped` and the sender is told ("Birthday message to Fatma was not sent — system was unavailable").

---

### 16.7 Client messages (WhatsApp)

The server never holds a WhatsApp session (§15.10), so a scheduled client message reaches the **sender's phone** as a `send_jobs` row:

1. The dispatcher claims the reminder at `fire_at` and checks that:
   - `sender_id` is still a member
   - the client is still in the firm, has `phone_e164`, and is not opted out (`suppressed_at` is null). Opt-in (`opted_in_at`) is **not** checked.
   - the rendered body is non-empty

   If any check fails, the reminder is `skipped` with a reason and the sender gets an in-app notification.
2. **`requires_approval = true`** (recommended default): notify the sender "Birthday message to Fatma is ready" with Review / Send / Skip. Tapping Send inserts the `send_jobs` row from the client under normal RLS.
3. **`requires_approval = false`**: the dispatcher inserts the row itself with `created_by = sender_id`, `source_reminder_id`, and `expires_at = fire_at + window`. The window is 6 h by default, set per reminder.
4. The phone claims it through the existing §15.10 path (Realtime, or on launch/resume). The claim now also requires `expires_at > now()`. An unclaimed job past expiry is moved to `expired` by the dispatcher, and the sender is told.
5. It is sent through the normal outbox → Node → `message_history` path, so it appears in the client's history like any other message.

This inherits the §15.10 limitation unchanged: **the message only goes out if the sender's phone is running CRMEX in time**. The auto-send path is therefore "will send when your phone is next online, up to 6 h late, otherwise not at all". The UI should say exactly that when a user turns approval off. Approval is also the §12-friendly default: a person confirms each outbound message before it goes out.

A client message is claimed once, by one phone, within one window, so it is sent at most once.

---

### 16.8 UI

**Navigation.** Add **Calendar** as the first tab (Calendar · Clients · Matters · Tasks · Messages), plus a bell icon in the header for the inbox. Five tabs is the practical maximum on a phone, so see open decision D2 on merging Tasks.

| Screen | Content |
| :--- | :--- |
| **Calendar**, phone | Agenda list: *Overdue / Needs confirmation / Today / This week / Later*. Toggle between Mine and Firm. Month strip on top. |
| **Calendar**, browser | Month / week / agenda views. Drag to move, which opens the move-preview sheet (§16.5.2). Filters: member, matter, kind. |
| **Event sheet** | Date/time, date source badge (*Projected* / *Set manually* / *Confirmed*), assignee, matter/client links, reminders list (add/remove/edit), history of moves, Done / Missed / Cancel / Move. |
| **Move preview** | "Moving *First hearing* 27 Dec → 22 Dec will also move: *Prep call* 22→17 Dec, *Second hearing* …; 1 conflict: *Filing X* (confirmed) now falls before …". Reason field, then Confirm. |
| **Matter → Timeline** | Process steps as a vertical timeline, with gaps shown ("12 weeks"), badges and conflicts. **Apply process** button. |
| **Client → Dates** | Birthday field, upcoming events for this client, "Add birthday greeting" preset. The existing "Opted out" switch also covers scheduled messages; turning it on cancels the client's pending client-audience reminders and says how many. |
| **Settings → Process templates** (owner/admin; browser-first) | Step table editor with anchor/offset, reminder rules per step, a live preview ("if started today…"), and Publish (bumps version). |
| **Settings → Notifications** | Firm timezone, whether names appear in notifications, default client-message window. Per user: which reminders, quiet hours, device-notification permission status, and the Huawei whitelist prompt. |
| **Inbox** | Notifications with actions (Open, Done, Approve & send, Reschedule). |

---

### 16.9 Security & tenancy checklist

- Every new table: `org_id` + composite FKs + `guard_org_id`. RLS as in §16.4. Live tests with two firms (as `test:live` already does).
- `anchor_event_id`, `process_id`, `matter_id`, `client_id` and `recurrence_of` use composite FKs, so a process can never anchor to or cascade into another firm's events.
- `apply_process` / `preview_move` / `apply_move` are `security invoker` with a pinned `search_path`, so a firm-B user calling them with firm-A ids gets "not found".
- The dispatcher uses the service role:
  - recipients come from `org_members` at fire time
  - `send_jobs.created_by` comes only from `event_reminders.sender_id`, whose insert RLS required `sender_id = auth.uid()`
  - no signed URLs or message bodies in logs
- Notification bodies are rendered server-side from firm data and sent only to members of that firm. External channels get the minimal form by default (§16.6.2).
- The operator sees nothing (§15.8). No per-firm reminder counts on admin screens.

---

### 16.10 Build order (proposed)

16. **Schema**: the §16.4 migrations, triggers (derived `starts_at`/`fire_at`, assignee membership, DAG validation), RLS, and SCH isolation tests offline (fake) + `test:live`.
17. **Events & calendar UI**: manual events with reminders, agenda/month views, event sheet, move with cascade preview (`preview_move`/`apply_move`), event history. Firm timezone setting.
18. **Dispatcher**: `core-server` job that claims reminders, writes the in-app inbox, runs the overdue/unconfirmed sweeps and catches up after downtime. Inbox UI.
19. **Device notifications**: local-notification sync on Android, permission flow, Huawei whitelist prompt.
20. **Templates & processes**: template editor, `apply_process`, matter timeline.
21. **Client messages**: `send_jobs.expires_at`, approval flow, auto-send path, birthday preset + yearly recurrence.
22. **Reliable staff channel**: email or FCM (decision D1).

Steps 16–19 alone already give a working calendar with reminders. Templates come after that because they only add value once moving and reminding work.

---

### 16.11 Deferred (phase 2)

- **Business days and court holidays** (`org_holidays`, `offset_unit = business_days`). Needed for real procedures, but the holiday data is per jurisdiction.
- ~~**Firm-wide occasion rules**~~ — promoted out of phase 2 and designed in **§19**.
- **Explicit matter team** (`matter_members`), which makes the `matter_team` audience precise.
- **Starter template library** published by the operator and copied into a firm. The operator writes templates, never reads firm data.
- **Calendar sync / ICS feed.** A per-user ICS URL is a bearer credential exposing privileged dates, so it needs a deliberate decision.
- **Court availability / booking integration.**

---

### 16.12 Tests

The `SCH-*` cases live in `test-plan.md` §19.

---

### 16.13 Open decisions

| # | Decision | Options | My recommendation |
| :--- | :--- | :--- | :--- |
| **D1** | Reliable staff channel that doesn't depend on the phone app | (a) email, (b) FCM push, (c) local notifications only for now | **(a) email** next, after phase-1 local notifications. It works for browser-only users too and needs no Firebase setup. FCM after that. |
| **D2** | Tasks vs events | (a) keep `tasks` for to-dos, move `hearing`/`deadline` kinds into events, Calendar shows tasks with due dates as markers; (b) fold tasks into events entirely (one "Agenda" tab); (c) keep both as they are | **(a)**. `tasks` is shipped and simple; a hearing belongs on the calendar with reminders. The Tasks tab could merge into Calendar later. |
| **D3** | Client message default | approve-first vs auto-send | **Approve-first**; auto-send can be switched on per reminder. |
| **D4** | Where the dispatcher runs | (a) interval loop inside the `core-server` process; (b) external scheduler (Supabase Cron / host cron / a gyrfalcon deployment, §17.7) calling a protected `core-server` endpoint | **(b)** if `core-server` may run multiple instances or scale to zero; **(a)** is fine for a single instance. The `skip locked` claim makes either safe. |
| **D5** | Who can edit templates | owner/admin vs any member | **Owner/admin**. A template change affects every future matter. |
| **D6** | Timezone of client messages | firm timezone vs client's own | Client's own if set, otherwise the firm's. |
| **D7** | Business days / holidays in phase 1? | yes / defer | **Defer**. Firms can enter calendar-day offsets and adjust with a move. |
| **D8** | Scope change | This reverses "campaign scheduling" and "push reminders" being out of scope in PLAN.md §3 | Confirm; `PLAN.md` §3/§4 are updated when this section is approved. |

---

## 17. Agentic engine — gyrfalcon integration

**Status: designed 2026-09-17, under review; not implemented.** Open decisions are in §17.10. **Amended 2026-09-19 by §22:** gyrfalcon never writes but `core-server`'s executor does, per the owner's autonomy matrix; read tools are now required (so G4 and G2 become prerequisites for real firm data); and G7 is added.

Gyrfalcon is a self-hosted Python agent platform. On the dev machine it lives in WSL at `/home/ubuntu/agent/gyrfalcon`, and its own specs are in `docs/spec/gyrfalcon/`. It provides three capabilities CRMEX wants:

- **chat**: an agent loop with tools, skills, MCP servers and persistent sessions
- **flows**: `@flow`/`@task` Python workflows with durable runs, retries, human-in-the-loop pauses, and deployments with schedules
- **scheduler**: timed prompt or skill jobs

This section says how CRMEX uses each of them without breaking the tenancy rules in §15.

### 17.1 What gyrfalcon provides today (verified against its code, 2026-09-17)

| Area | As built | Consequence for CRMEX |
| :--- | :--- | :--- |
| HTTP surface | Dashboard API under `/api/*` (FastAPI, `127.0.0.1:9119` by default). The versioned `/v1` REST gateway (its spec 14) is **designed but not built**. | CRMEX integrates against `/api/*` for now and treats it as an internal, unstable contract behind one adapter (§17.3). |
| Chat invoke | `POST /api/agents/{id}/invoke` (and the public `POST /api/gateway/agents/{id}` with `X-Agent-Key`) starts a background thread and returns `{session_id}` immediately. Output goes to an **in-memory** event bus that only a connected `/api/ws` client sees. **There are no durable run records** (its spec 14 §13 calls this "blocks everything"). | Results are read back with `GET /api/sessions/{id}/messages` after the WebSocket reports completion, or by polling. A process restart mid-turn loses the turn with no failed state. |
| Flows | Flow files are imported from `~/.gyrfalcon/flows/*.py`. `POST /api/flow/definitions/{name}/run {parameters}` → `run_id`. `GET /api/flow/runs/{id}` for state/result. Human-in-the-loop via `pause_flow_run` + `POST /api/flow/tasks/{run_id}/respond`. Deployments (`/api/flow/deployments`) bind a flow to parameters and a schedule, ticked every 5 s by the runner **inside the dashboard process**. Persistence is SQLite or PostgreSQL. | This is the most mature piece and the main integration point. |
| Scheduler | Prompt/skill jobs in `~/.gyrfalcon/scheduler/jobs.json`, a 60 s tick, a 3-minute cap per job, and it runs **only inside the `gyrfalcon gateway` process**. **Jobs are not scoped by tenant.** | Not suitable for per-firm or per-event scheduling (§17.7). |
| Identity | `identity.enabled` is **off** in the current config, so every caller is the `LOCAL` principal. When on, a principal is `(user_id, tenant_id, roles)`, and sessions and flow runs are filtered by it. The ways to authenticate are: OIDC login (browser); per-user API keys `gyr_live_…` (bound to one user in one org); and service-account client-credentials tokens, which **always resolve to `LOCAL`**, are kept **in process memory**, and don't survive a restart. There is no HTTP route to create orgs or users. | See §17.4: CRMEX's tenancy can't be expressed with what exists without a small gyrfalcon change. |
| Third-party JWTs | Refused by design (`accept_bearer_token()` raises). Gyrfalcon won't verify a Supabase JWT. | CRMEX clients never call gyrfalcon directly. |
| Delivery | `gateway.platforms` is empty (no email/Slack/etc. adapters configured). `send_message` falls back to logging. | Gyrfalcon cannot deliver reminders or client messages; §16.6/§16.7 stay as designed. |
| Operator view | The dashboard shows every session, flow run and result to its operator (`LOCAL` has the `operator` role). | Conflicts with §15.8 (the operator never sees firm data). See §17.8. |

### 17.2 Architecture

```text
 phone / browser ──HTTPS + Supabase JWT + X-Org-Id──▶ core-server ──(private)──▶ gyrfalcon
                                                      │  ▲                           │
                                                      │  └──── tool calls / callbacks ┘
                                                      ▼
                                                   Supabase
```

Rules:

1. **Gyrfalcon is a private backend of `core-server`, never reachable from a client.** It binds to a private interface only; on the dev box that is WSL `127.0.0.1:9119`, reached from Windows via localhost forwarding. The phone and browser keep talking only to `core-server`. That keeps §15.4's enforcement order intact: verify the Supabase JWT, verify `X-Org-Id` against `org_members`, *then* call gyrfalcon on the firm's behalf.
2. **Supabase stays authoritative for all firm data**, including §16's events, dates and reminders. Gyrfalcon holds working state only: conversation transcripts, flow run state and results. It never becomes the place where a court date lives.
3. **Agents propose; people and deterministic code commit.** This matches gyrfalcon's own §19 invariant. An agent or flow **never** sends a WhatsApp message, moves an event, or edits a client directly. It returns a **proposal**. The user confirms it in CRMEX, and the confirmation runs through the normal RLS-checked path (`apply_move`, `send_jobs`, …).
4. **AI provider keys** may live in gyrfalcon, which is server-side, so §1 invariant 1 still holds. `core-server` keeps its own `LlmProvider` for the short synchronous calls it already makes (§17.5).

### 17.3 The adapter in `core-server`

All gyrfalcon calls go through one module, `core-server/src/agent/gyrfalcon/`, behind an interface, so the `/api/*` → `/v1` migration touches one file:

```typescript
export interface AgentEngine {
  startChatTurn(ctx: TenantCtx, sessionRef: string | null, message: string): Promise<{ sessionRef: string; turnRef: string }>;
  getChatTurn(ctx: TenantCtx, turnRef: string): Promise<ChatTurnResult>;      // status, text, proposals
  streamChatTurn(ctx: TenantCtx, turnRef: string): AsyncIterable<ChatEvent>;  // relayed to the client as SSE
  startFlow(ctx: TenantCtx, flow: FlowName, params: object): Promise<{ runRef: string }>;
  getFlowRun(ctx: TenantCtx, runRef: string): Promise<FlowRunResult>;
  answerPause(ctx: TenantCtx, runRef: string, input: object): Promise<void>;
  cancel(ctx: TenantCtx, ref: string): Promise<void>;
}
// TenantCtx = { orgId, userId, role } — always from the verified JWT + org_members, never from the request body.
```

A `fake` implementation lives next to it so `npm test` stays offline.

**Ownership mapping lives in Supabase**, not in gyrfalcon ids:

```text
agent_runs        -- firm-scoped, RLS: members read; inserted/updated by core-server only
  id, org_id, user_id, kind (chat | flow), engine_session_ref, engine_run_ref,
  flow_name, status (queued | running | paused | completed | failed | cancelled),
  error, created_at, finished_at

agent_proposals   -- firm-scoped
  id, org_id, run_id, kind (draft_message | move_event | create_event | apply_process | update_client | …),
  payload jsonb, status (pending | accepted | rejected | expired), decided_by, decided_at
```

Every read or write of a gyrfalcon ref first loads the `agent_runs` row **filtered by the verified `org_id`**. A ref from another firm is a 404 before gyrfalcon is ever called, so a guessed or leaked gyrfalcon id is useless. This is the same rule as `send_jobs` and Storage paths.

### 17.4 Tenancy inside gyrfalcon

`core-server`'s checks come first, but a firm's transcripts must also be separated **inside** gyrfalcon, so a bug on one side doesn't leak. Options:

| | How | Isolation | Cost |
| :--- | :--- | :--- | :--- |
| **A. Tenant assertion (recommended)** | Turn on `identity.enabled`. Add one auth path to gyrfalcon: a **trusted service credential** (the `core-server` key, stored hashed) that may assert `X-Gyrfalcon-Tenant` (= CRMEX `org_id`) and `X-Gyrfalcon-User` (= CRMEX user id) per request, **or** a short-lived token signed by `core-server` carrying those claims. The principal is then that user in that tenant, so sessions, flow runs and pause "performers" filter per firm and per user. | Strong: gyrfalcon's structural `Scope` filter applies per firm. | A small gyrfalcon change: an auth path in `_resolve_principal` and tenant auto-provisioning in `auth/store.py`. |
| B. Per-firm API key | Create a gyrfalcon org and service user per CRMEX firm and mint a `gyr_live_` key for it. `core-server` stores the keys (secret manager) and selects one by verified `org_id`. | Per firm, but every member acts as one gyrfalcon user; pause performer = firm. | No HTTP route creates orgs/users today, so provisioning is a script. N secrets to manage. |
| C. Single `LOCAL` principal | Identity off; `core-server` alone enforces isolation via `agent_runs`. | **None inside gyrfalcon**: all firms' transcripts share one owner and are visible in its dashboard. | Zero gyrfalcon changes. **Dev only.** |

**Recommendation: C for local development now, A before any real firm data reaches gyrfalcon.** Two things aren't possible with gyrfalcon as it stands: service tokens resolve to `LOCAL` and don't survive a restart, and nothing lets `core-server` act for many tenants with one credential.

### 17.5 Chat

The **Assistant** screen in the app:

1. `POST /api/v1/assistant/turns {sessionId?, message}` → `core-server`:
   - verifies JWT and firm
   - checks quota (`org_usage_daily`, new `agent_turns` counter)
   - inserts `agent_runs(kind='chat')`
   - calls `startChatTurn` with the gyrfalcon agent id (one shared "CRMEX assistant" agent definition; the tenant comes from §17.4)
2. `GET /api/v1/assistant/turns/:id/events` (SSE): `core-server` subscribes to gyrfalcon's `/api/ws` for that session and relays `message.delta` / `tool.start` / `message.complete`. Tool names are relayed; tool arguments and results are not. On reconnect it falls back to `GET /api/sessions/{id}/messages`.
3. On completion, `core-server` stores the status (not the text) on `agent_runs`, extracts any proposals into `agent_proposals`, and the client renders them as action cards ("Move *First hearing* to 22 Dec — Review").

**What the agent can see (tools).** Two stages:

- **Stage 1: context push, no inbound tools.** `core-server` loads what the question needs (active matter, client, upcoming events) under the user's firm and passes it in the turn message as structured context. The agent has no CRMEX tool and cannot reach anything the user didn't send. Simple and safe; limited to what `core-server` anticipated.
- **Stage 2: tool callback.** `core-server` exposes `/internal/agent-tools/*` as an MCP-over-HTTP (or OpenAPI) server that gyrfalcon's `mcp_tool` / `openapi_mcp_tool` calls:
  - Read tools: `search_clients`, `get_matter`, `list_events`, …
  - Proposal tools: `propose_move_event`, `propose_message`, … These only write `agent_proposals`.
  - Each call carries a **run-scoped token** minted by `core-server` at turn start. It is bound to `(org_id, user_id, run_id)`, lasts about 15 min, and is revoked at run end. `core-server` resolves the firm from the token, never from tool arguments.
  - Gyrfalcon's MCP config is global per profile, so passing the per-run token needs either a per-call header hook in gyrfalcon or the token injected by the agent runtime (never by the model). This is a gyrfalcon change to confirm (G4).

**What stays out of gyrfalcon:** message drafting (`POST /messages/draft`) and contact matching stay on `core-server`'s own `LlmProvider` (§6). They are short, synchronous and high-volume, and gyrfalcon's invoke path is asynchronous with no durable result. A `GyrfalconLlmProvider` adapter can be added later if central model routing becomes the goal.

### 17.6 Flows

Flows fit work that is **multi-step, slow, or needs a human in the middle**. They do **not** replace §16's scheduling model: a court date that "lives" in a flow paused for three months would duplicate the calendar, and moving it in the app would not move the flow.

The CRMEX flows are Python files kept in this repo (`crmex/agent-flows/`) and deployed into gyrfalcon's flows folder, since gyrfalcon imports `~/.gyrfalcon/flows/*.py`:

| Flow | Trigger | Steps | Commits |
| :--- | :--- | :--- | :--- |
| `crmex_court_notice_intake` | User uploads a court notice/letter (image or PDF) on a matter | extract dates, parties and case number (`agent_step`) → match to matter events → **pause** for the lawyer to confirm | Proposals: `move_event` / `create_event`, marked `fixed` (§16.5.2). Applied only on accept. |
| `crmex_process_from_description` | "Set up a divorce timeline for this matter" in chat, or a template-less matter | pick a template or draft steps → **pause** for review | Proposal: `apply_process` (§16.5.1) |
| `crmex_hearing_prep` | N days before each `hearing` event (triggered by the §16.6 dispatcher, not gyrfalcon's scheduler) | gather the matter summary, open tasks, last client messages → draft a prep checklist and a client reminder | Proposals: tasks + `draft_message` |
| `crmex_greeting_draft` | §16.7 client greeting reminder with `requires_approval` | personalise the greeting from client notes | Proposal: `draft_message`. The approval notification shows this text. |
| `crmex_daily_digest` | Per firm member, each morning | summarise today's and overdue events | In-app notification (§16.4.3), later email |

Mechanics:

- **Start**: `core-server` → `startFlow(ctx, name, params)`. `params` carry **ids only** (`matter_id`, `event_id`) plus, in stage 2, the run-scoped tool token. Never client names or message bodies, because gyrfalcon persists flow parameters.
- **Pause**: the flow calls `pause_flow_run(key=…)`. Gyrfalcon records it. `core-server` learns of it by polling `getFlowRun` (gyrfalcon has no webhooks yet), marks `agent_runs.status = 'paused'`, and notifies the user in-app. The user answers in CRMEX, and `core-server` calls `answerPause` as that user (option A makes gyrfalcon's performer check meaningful).
- **Results**: a finished flow returns `{ proposals: [...] }` as its result. `core-server` validates each proposal **against the firm's current data** (the event still exists in this firm, the date is sane) before inserting `agent_proposals`. A proposal referring to an id outside the firm is dropped and logged.
- **Polling**: a `core-server` job polls non-terminal `agent_runs` (every 10 s while fresh, backing off to 1 min). Replace with gyrfalcon webhooks once its spec 14 §7 exists.

### 17.7 Scheduler

**Gyrfalcon's scheduler is not used for CRMEX firm work.** Its jobs live in one global `jobs.json` with no tenant field, run only while `gyrfalcon gateway` is up, and cap at 3 minutes. A court-date reminder system can't depend on that.

- **§16's dispatcher stays in `core-server` + Postgres.** Reminders, cascade and claims all need transactional SQL next to the data.
- **A gyrfalcon deployment may act as the *clock*** (§16.13 D4 option b): a deployment named `crmex-dispatch-tick`, scheduled `every 1m`, runs a trivial flow that calls `POST /internal/scheduler/tick` on `core-server` with an internal credential. This gives run history and retries for free. Requirements if chosen:
  - the tick is idempotent (the `skip locked` claim already makes it so)
  - `core-server` raises an alert and runs its own fallback loop if no tick arrives for 5 min, so an outage of gyrfalcon's dashboard process can't silently stop court reminders
- **Agentic scheduled work** (`crmex_hearing_prep`, `crmex_daily_digest`) is triggered by the `core-server` dispatcher from §16 data, which calls `startFlow`. Gyrfalcon never holds per-event schedules.

### 17.8 Security and the operator boundary

- **The gyrfalcon dashboard is an operator console over firm transcripts.** Under §15.8 the operator must never see firm data. In production:
  - its UI must not be reachable by platform operators (no public bind, no shared token)
  - identity option A must be on
  - no operator account is a member of any firm tenant

  If the operator needs gyrfalcon's console for agent config, that is a deliberate §15.8 amendment, not a default.
- **Minimise what gyrfalcon stores.** Flow params carry ids only. Chat transcripts necessarily contain what users typed and the context `core-server` pushed.
- **Retention**: gyrfalcon's sessions and flow runs for CRMEX tenants are deleted after `retention.agent_transcript_days` (new `app_settings` key, default 30). This is enforced by the `core-server` retention job calling gyrfalcon's delete APIs (`DELETE /api/sessions/{id}`, `DELETE /api/flow/runs/{id}`) via `agent_runs`.
- **Offboarding (§15.6)**: a removed member's `agent_runs` stay with the firm, but their paused flows can no longer be answered by them. `core-server` re-checks membership before `answerPause`.
- **Prompt injection**: court notices, client messages and notes are untrusted input to an agent. Because agents only propose (§17.2 rule 3) and proposals are re-validated and human-confirmed, an injected instruction can at worst produce a bad proposal, never an action.
- **Internal credentials**:
  - `core-server` → gyrfalcon: the §17.4 service credential
  - gyrfalcon flows → `core-server`: a separate internal key accepted only on `/internal/*`, and in stage 2 the run-scoped tokens

  Neither is ever logged. `/internal/*` is not exposed through the public ingress.
- **Quotas (§13.5)**: `agent_turns` and `flow_runs` per firm per day in `org_usage_daily`, checked before any gyrfalcon call.

### 17.9 Gyrfalcon changes this integration needs

Listed so they can be scheduled in the gyrfalcon repo. None block the dev-only stage 1 path.

| # | Change | Needed for | Blocks |
| :--- | :--- | :--- | :--- |
| G1 | Durable agent run records + `GET` run result (its spec 14 §13) | Reliable chat results; failed state after restart | Production chat |
| G2 | Service credential that asserts tenant/user, with tenants auto-provisioned (option A) | Firm isolation inside gyrfalcon | Real firm data |
| G3 | Persisted service tokens (today in process memory), or the signed-assertion variant of G2 | Surviving restarts | Production |
| G4 | Per-call credential injection for MCP/OpenAPI tools | Stage 2 tools | Stage 2 |
| G5 | Webhooks for run/flow completion and pause (its spec 14 §7) | Replacing polling | Nothing (polling works) |
| G6 | Session/flow-run deletion by tenant for retention | §17.8 retention | Production |

### 17.10 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **G-D1** | Tenancy inside gyrfalcon | A tenant assertion / B per-firm keys / C single `LOCAL` | **C in dev now, A before real data** (§17.4) |
| **G-D2** | How agents see CRMEX data | stage 1 context push only / stage 2 tool callback | **Stage 1 first**. Add stage 2 once G4 exists. |
| **G-D3** | Drafting & matching engine | keep `core-server` `LlmProvider` / move to gyrfalcon | **Keep** (§17.5) |
| **G-D4** | Where flows' source lives | `crmex/agent-flows/` deployed into gyrfalcon / written directly in gyrfalcon's folder | **In this repo**, so CRMEX changes and their flows ship together |
| **G-D5** | Clock for the §16 dispatcher | `core-server` interval / gyrfalcon deployment tick with fallback | **`core-server` interval** until gyrfalcon runs as a supervised production service; the §17.7 tick is optional |
| **G-D6** | Operator access to gyrfalcon's dashboard in production | none / config-only / full (amends §15.8) | **None** |
| **G-D7** | Hosting | same private network as `core-server` / separate | **Same private network, never public.** Gyrfalcon needs the dashboard process (flows + runner), and the gateway process only if its scheduler is used. |

### 17.11 Build order (proposed, after approval)

1. **Adapter + fake**: `AgentEngine`, `agent_runs`/`agent_proposals` migrations with RLS, live tests (a firm B user can't read firm A runs or proposals, and a guessed gyrfalcon ref returns 404).
2. **Chat, stage 1**: assistant screen, SSE relay, context push, proposal cards (accept runs the normal RLS path).
3. **First flow**: `crmex_court_notice_intake` with pause/answer and proposal validation.
4. **Gyrfalcon G1–G3, G6**, then turn on option A.
5. **Scheduled flows** from the §16 dispatcher (`hearing_prep`, `greeting_draft`, `daily_digest`).
6. **Stage 2 tools** after G4.

Test cases get IDs `AGT-*` in `test-plan.md` §20 once this section is approved.

---

## 18. Scheduled bulk send — campaigns

Designed 2026-09-18. Not implemented. This is the product's headline flow made explicit and given a schedule: **search clients → select some or all → write or generate a message → paste or generate an image → choose when it goes out and how fast → one paced run.**

Nothing here is a new sending mechanism. A campaign is a `send_jobs` row (§15.10) with three added columns and the same claim/outbox/mirror path. §16 (processes and reminders) schedules *one* message off a matter date; this schedules *one message to many clients* off a wall-clock time the user picks.

### 18.1 Why it is only an extension of `send_jobs`

`send_jobs` already carries `org_id`, `created_by`, `body`, `media_path`, `recipients jsonb`, a status machine enforced by trigger for every writer, an atomic claim, and RLS that lets only the creator's phone run it. A campaign needs exactly three things that row does not have: *when* to start, *how fast* to go, and *how late is too late*. Everything else — tenancy, immutability after insert, the `batch_id = job id` link into `message_history` — is reused unchanged.

A second table would duplicate the trigger and the RLS, and would give the phone two queues to poll. There is one queue.

### 18.2 Decisions taken

| # | Decision | Answer |
| :--- | :--- | :--- |
| **C1** | Who sends at the scheduled time | **The sender's own phone**, as in §15.10. The phone is positioned as an always-on gateway. |
| **C2** | Server-side wake-up (FCM) | **Designed for, not built** (§18.9). The claim path is written so a push only makes the phone poll sooner; it never becomes a second sender. |
| **C3** | Pacing control | **One interval per campaign, with jitter.** The user picks 10 s / 30 s / 60 s / custom; each actual gap is randomized ±25 % around it. Clamped to the firm's `pacing.min_interval_ms` floor. |
| **C4** | Where a phone-created campaign lives | **The same `send_jobs` row.** Both clients write to Supabase; the phone claims its own row. One code path, and a campaign created on the phone is visible and cancellable from the browser. |
| **C5** | Late or missed runs | **A late window, then `expired`** — reusing `expires_at` and the `queued → expired` transition already specified in §16.4.1. Default 6 h, set per campaign. |

C4 is a deliberate narrowing of "mobile need not sync": per-message *results* still mirror best-effort (§9.2), but the *campaign itself* is created online. A phone with no connectivity at compose time cannot schedule — it can still send immediately through the existing direct path (`directSender.ts`), which needs no row.

### 18.3 Data model

#### 18.3.1 `clients.status` — who is eligible at all

Decided 2026-09-18. A campaign targets **active clients**; inactive ones are never included. `clients` has no such field today, so this section adds one:

| Column | Type | Meaning |
| :--- | :--- | :--- |
| `status` | `text not null default 'active' check (status in ('active', 'inactive', 'archived'))` | CRM lifecycle of the relationship. `inactive` = a former or dormant client kept for history; `archived` = hidden from normal lists entirely. |

**`status` is not consent, and the two must not be merged.** `suppressed_at` (§12) is a standing instruction from the *person* — "stop messaging me" — and it outlives everything: reactivating a client must never resume messaging someone who opted out. `status` is the *firm's* view of the relationship, set by staff for their own filing. A client can be active and opted out (a current client who does not want bulk messages), or inactive and never opted out (a matter that closed).

Both block a campaign, for different reasons, and both are re-checked at claim time. Because they are different reasons, the excluded line names them separately — "3 opted out · 12 inactive" — since a user who sees only a count will assume the wrong one.

Effects elsewhere:

- The Clients list defaults to `status = 'active'`, with a filter to show the others. Archived clients are excluded from search and from NL matching (§7.4) unless explicitly asked for.
- Scheduled client messages (§16.7) skip a client that is not active at fire time, with the same notification as the other skip reasons.
- Existing rows default to `active`, so the migration changes no behaviour on its own.

#### 18.3.2 `send_jobs` — when and how fast

Three columns on `send_jobs`, plus the status and constraint from §16.4.1. All nullable, so every existing row and the immediate-send path are unaffected: `scheduled_at is null` means "run as soon as the phone sees it", which is exactly today's behaviour.

| Column | Type | Meaning |
| :--- | :--- | :--- |
| `scheduled_at` | `timestamptz` | When the phone may start. Null = immediately (today's behaviour). |
| `interval_ms` | `integer` | Base gap between consecutive sends. Null = the firm's `pacing.*` window (§9.4). |
| `jitter_pct` | `smallint not null default 25` | Randomization applied to `interval_ms`, in percent. |
| `expires_at` | `timestamptz` | From §16.4.1. Past this, the job is never claimed and becomes `expired`. |

Constraints, all enforced in the existing `send_jobs_guard()` trigger so the service role is bound by them too:

- `interval_ms` is null or `>= app_settings.pacing.min_interval_ms` and `<= 3600000` (1 h). The floor is read inside the trigger, not trusted from the client.
- `jitter_pct between 0 and 50`.
- `expires_at`, when set, is `> coalesce(scheduled_at, created_at)`.
- `scheduled_at`, `interval_ms`, `jitter_pct` and `expires_at` are **immutable after insert**, like `body` and `recipients`. Rescheduling is cancel-and-recreate, which keeps one row = one run and avoids a job being re-timed while a phone is mid-claim.

The claim predicate (§15.10) gains two clauses:

```sql
update send_jobs set status = 'claimed'
where id = :id and status = 'queued' and created_by = auth.uid()
  and (scheduled_at is null or scheduled_at <= now())
  and (expires_at   is null or expires_at   >  now())
returning *;
```

Both are re-evaluated by Postgres on the locked row, so the existing concurrency argument (TEN-24, TEN-28) carries over unchanged: a second claimer updates zero rows.

**The predicate alone is not enough, and this is easy to get wrong.** RLS lets the creator update their own row, so a client that simply *omitted* those two clauses would claim a campaign before its time or after its expiry. The `WHERE` clause is what makes the claim **atomic**; it is the **trigger** that makes the schedule **binding**, by rejecting a `queued → claimed` transition outside the window for every writer including `service_role`. Both are needed, for different reasons — the same division as the existing status machine, where the trigger owns legality and the predicate owns concurrency.

A consequence worth stating: the caller's `now` comes from the device clock, so a phone with a skewed clock may *try* to claim early. The trigger uses Postgres `now()`, so the attempt fails. A skewed device can therefore delay its own campaign or waste a claim, but it cannot make one run at the wrong time.

**Expiry** is swept by the §16.6 dispatcher (`queued → expired` where `expires_at <= now()`), and the sender is notified. If §16 ships later than this section, the phone also treats a past-`expires_at` job as expired on sight and reports it; the dispatcher sweep is what covers a phone that never comes back.

### 18.4 The compose flow

Five steps in `shared-ui`, identical on both clients. Steps 1–3 already exist in the send wizard; 4 is partly new, 5 is new.

1. **Find clients.** The existing filters (kind, tag, text) plus natural-language matching (§7.4) against the firm's `clients`. The result is a list the user confirms — a query never becomes a send by itself.
2. **Select.** Per-row checkboxes and **Select all matching** (the whole result set, not just the loaded page — the count is shown, and it is the count that gets checked against `limits.max_batch_recipients`). Only `status = 'active'` clients are selectable; inactive and archived ones are not offered at all. Clients with no `phone_e164` or with `suppressed_at` set are shown struck through, are not selectable, and are counted in the excluded line, which names each reason separately (§18.3.1). Both status and suppression are re-checked at claim time regardless (§15.10).
3. **Message.** Free text, or generated via `POST /api/v1/messages/draft`, then edited. `{name}` is the only placeholder, rendered per recipient with `replaceAll` (§9.5). Either the body or an image is required — the existing `send_jobs_content_check`.
4. **Image (optional).** Three sources:
   - **Generate or search with AI** — the existing §8 loop, ending at an `image_sessions.current_path`.
   - **Paste or attach** — new. The client posts the bytes to `POST /api/v1/images/upload`; the server sanitizes them, hashes the result, stores at `<org_id>/<user_id>/<sha256>.png`, and returns the object path and a signed URL, exactly as the generate path does. The path is constructed from the JWT, never from the client. This endpoint is the only gap in the existing server for this feature.

     **PNG only, stripped by chunk rather than re-encoded.** `buildObjectPath` already yields a `.png` path, and `core-server` has no image decoder — accepting JPEG or WebP would mean adding a native dependency (sharp) for one endpoint. PNG's container makes the same guarantee available as a pure structural pass: the file is a sequence of length-tagged chunks, and everything carrying EXIF, GPS, comments or provenance text (`eXIf`, `tEXt`, `zTXt`, `iTXt`, `iCCP`, `tIME`) is an *ancillary* chunk a decoder must be able to ignore. The server keeps a small allowlist (`IHDR`, `PLTE`, `IDAT`, `IEND`, plus `tRNS`/`gAMA`/`sRGB`, which change how the image looks rather than what it reveals) and drops everything else, so an unknown future chunk type is dropped by default. Clients convert to PNG before upload (`canvas.toBlob` in the browser, which incidentally drops EXIF too) — but the server never trusts that, because a client can still send a PNG carrying an `eXIf` chunk. A size cap comes from `app_settings`.

     Why this matters beyond tidiness: a photo pasted from a phone carries the GPS coordinates where it was taken, and these are law firms' clients. Stripping it is not optional, and doing it structurally means it can be verified by reading the code rather than trusting a library.
   - **Reuse** an image from a previous session.
5. **Schedule and pace.** *Send now* or a date and time (in the firm's timezone, §16.4.1); the interval preset or a custom value; the late window. The screen shows the arithmetic before confirming, because 400 recipients at 30 s is 3 h 20 m and users do not compute that themselves:

   > **412 recipients · every 30 s (±25 %) · starts Fri 19 Sep 09:00 · finishes ≈ 12:26**
   > Your phone must be online and running CRMEX for the whole run.

   Then the existing `SendConfirmation` gate (§9, `confirmationGate.ts`) with the recipient count.

### 18.5 Running a campaign

The phone's `jobRunner.ts` changes in two places and nowhere else: `listRunnableJobs` filters on the two new time clauses, and the pacing window handed to the Node payload comes from the job rather than the global default.

```
claim ──▶ re-check status + suppression + onWhatsApp() ──▶ write every recipient to outbox PENDING
      ──▶ hand batch + pacing window to Node over IPC
      ──▶ per result: update outbox, mirror to message_history (batch_id = job id)
      ──▶ status = done (or failed)
```

Pacing math stays in `shared-ui/src/pacing/pacing.ts`: a campaign is just a `PacingWindow` of `{ min: interval*(1-jitter), max: interval*(1+jitter) }`, so `randomInterval` and its tests are reused as they are. The plain-JS copy in the Node payload (§10.4) needs no change — it already takes a window.

**Interruption.** A 3-hour run will outlive a `dataSync` foreground service's 6-hour cap only rarely, but it will certainly meet OEM battery kills (§10.2). The run is resumable because `outbox` holds every unsettled recipient (§9.2), and resumption is the existing path: on launch, unsettled rows for a `claimed` job are re-offered. A job that is `claimed` with unsettled `outbox` rows and no running batch is shown as **Paused — resume**, never silently restarted, because the claimed-but-unsettled row may already have been delivered (§9.2).

**Two campaigns due at once (decided 2026-09-19).** They **interleave**, sharing the pacing floor between any two messages, so neither waits for the other to finish — except a campaign of **fewer than 20 recipients**, which is instead **started 1–2 minutes later** than the campaign it collided with. The split is deliberate: a short run finishes quickly, so delaying it costs almost nothing and keeps its stated pacing exactly true, while making a 400-recipient campaign wait three hours for another one is not a real option. Interleaving is what makes the stated interval a floor rather than a promise, which is why the estimate is presented the way §18.4 step 5 describes.

**Progress** is derived, not stored: `message_history` rows carrying `batch_id = job.id` give sent/failed/skipped counts, and the browser watches them over Realtime. No counter column, so a phone that dies mid-run cannot leave a lying number behind.

### 18.6 What the browser can do

> **Amended 2026-09-19 by §23.4:** a `claimed` campaign *can* now be cancelled from the browser or the phone, as a request the phone honours before its next send. The rule below about `claimed` campaigns is superseded; everything else stands.

Create, watch and cancel. It cannot send.

- Create a campaign, scheduled or immediate — the phone runs both.
- See every campaign in the firm (RLS: firm members read the firm's jobs), with status, schedule, pace and live per-recipient results.
- Cancel while `queued` (creator only, existing policy). ~~A `claimed` campaign cannot be cancelled from the browser — the phone is mid-run and owns it; the phone's own UI stops it.~~ **Superseded 2026-09-19 by §23.4:** a `claimed` campaign can be cancelled from the browser or the phone as a *request* (`cancel_requested_at`) that the phone honours before its next send; the creator, owners and admins may do it (this also supersedes "creator only"); unsent recipients end as `CANCELLED`, and sent messages stay sent.
- The campaign list must say plainly, per §15.10, that a scheduled campaign runs **only while the creator's phone is online with CRMEX running**, and it shows when that phone was last seen so the claim is checkable rather than hopeful.

**Device presence (decided 2026-09-19).** The phone is positioned as an always-on gateway, so "will it actually run?" has to be answerable before the scheduled time, not discovered afterwards:

```text
device_presence
  user_id uuid, device_id text          -- primary key (user_id, device_id)
  label text                            -- "Pixel 8", chosen on the device
  last_seen_at timestamptz not null
  app_version text
```

The phone upserts its row while running (on launch, resume, and on the job-poll tick), but **the server stamps `last_seen_at`**, via a trigger, exactly as `send_jobs` stamps `claimed_at`. A device that supplied its own timestamp — skewed clock, or deliberately — could make a dead phone look alive, which is the one thing this table exists to prevent.

RLS: a user reads and writes **their own** rows, and there is deliberately no policy granting a colleague direct `select`, because a row-level policy cannot hide individual columns. The entire cross-member surface is `org_member_presence(p_org_id)` (`security definer`), which returns `(user_id, last_seen_at)` for every member of a firm and nothing else. It fails closed: a caller who is not a member gets no rows rather than an error, so it cannot be used to probe which org ids exist. Fellow firm members may read `last_seen_at` for a user they share a firm with, so the campaign list can say "last seen 2 minutes ago" — but **not** `label` or `app_version`, which describe the person's hardware rather than the firm's work (§15.5). The list shows the creator's most recent device.

The UI distinction that matters is between *"will run"* and *"will probably not run"*: a phone last seen minutes ago is a live gateway, one last seen three days ago means the campaign is almost certainly going to expire, and the user should be told that **while scheduling**, not after.

**Direction (decided 2026-09-19): the server will drive the schedule; the phone stays a gateway.** Today the phone decides when a job is due (it polls and claims once `scheduled_at` passes). The intended end state is the §16.6 dispatcher deciding "this is due" and the phone only executing, which is also what §18.9's push wake-up needs. That dispatcher is built **with §16**, not before it, because §16 needs the same tick and building it twice would be waste. Nothing in §18.3 changes when it arrives: the atomic claim is still what prevents two devices running one job, and the trigger still enforces the window — a server-side dispatcher shortens the delay before a claim, it does not become a second sender.

### 18.7 Limits and safety

- `limits.max_batch_recipients` is checked in the UI, re-checked at claim time (already in `jobRunner.ts`), and is the reason **Select all** shows a count first.
- The pacing floor is a firm setting, not a user choice: a user can slow a campaign down but not speed it past `pacing.min_interval_ms`.
- Suppression (§12, opt-out) and `status` (§18.3.1) each exclude at selection *and* at claim, and are reported as distinct reasons. Unregistered numbers resolve to `SKIPPED`, not `FAILED` (§7.3).
- **Recipient overlap between campaigns (decided 2026-09-19).** At schedule time the wizard counts recipients this campaign shares with other campaigns due **on the same day in the firm's timezone**. Above **10 %** of the new campaign's recipients, it warns — "Of 412 recipients, 58 (14 %) are also in *Autumn newsletter* today" — and offers **Remove those recipients**, **Reschedule**, or **Send anyway**. At or below 10 % it says nothing, because a warning that fires constantly is a warning nobody reads.

  The rule lives in one place — `campaign_overlap(p_org_id, p_client_ids, p_at)`, a `security invoker` function so RLS still applies — rather than in each shell. Two clients render this wizard, and a threshold implemented twice is a threshold that will eventually disagree with itself. It returns the overlapping jobs with the shared client ids (so the wizard can offer to remove exactly those), the percentage, and whether it exceeds 10 %. "Above 10 %" is strictly greater: an exact 10 % does not warn. Only `queued` and `claimed` campaigns count — a `done` one has already sent, so a warning changes nothing.

  It **warns, never auto-excludes**. Two different messages to one client on one day is sometimes exactly right (a hearing reminder and a firm announcement), and silently dropping recipients would mean the user approved a list that is not the list that went out — the same objection that makes §18.3's frozen snapshot worth having. §19.6 treats a campaign colliding with an occasion rule the same way, and for the same reason.
- One image and one body per campaign. Per-recipient variation beyond `{name}` is out of scope; it multiplies the review surface and is the shape that turns this into a spam tool.
- Quotas count a campaign's messages the same as manual ones (`usage_daily`, `org_usage_daily`).

### 18.8 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **C-D1** | Default interval preset | 10 s / 30 s / 60 s | **Decided 2026-09-18: 30 s**, with 10 s seeded as `pacing.min_interval_ms`. The current global window is 7–18 s, which is fine for a handful of recipients and aggressive for 400. |
| **C-D2** | Campaign size ceiling | reuse `limits.max_batch_recipients` / a separate, lower campaign cap | **Decided 2026-09-18: reuse it.** One number to reason about. |
| **C-D3** | Two campaigns due at the same time on one phone | run sequentially / refuse to schedule an overlap / run and let pacing interleave | **Decided 2026-09-19: interleave**, sharing the pacing floor — except a campaign under 20 recipients, which is started 1–2 min later instead (§18.5). |
| **C-D4** | `{name}` fallback when a client has no display name | — | **Closed 2026-09-19 as moot.** `clients.display_name` is `not null` with a 1–200 character check, and recipients are built from that column, so a campaign recipient always has a non-empty name. No fallback is reachable. |
| **C-D6** | A client appearing in two campaigns due the same day | warn / block / auto-exclude | **Decided 2026-09-19: warn above 10 % overlap** and let the user remove, reschedule or proceed (§18.7). Never auto-exclude — the approved list must be the list that sends. |
| **C-D5** | Editing a scheduled campaign | cancel-and-recreate only / allow editing body before `scheduled_at` | **Decided 2026-09-18: cancel-and-recreate** (§18.3), enforced by the trigger's immutability check rather than only by the absence of an edit button. |

### 18.9 Deferred — server-side wake-up

Recorded so the design does not have to change when it is built. The phone stays the only sender; a push only shortens the delay between `scheduled_at` and the claim.

1. The phone registers an FCM token per device against `created_by`.
2. The §16.6 dispatcher, on each tick, pushes a data-only message to the creator's devices for jobs that have just become due.
3. The app wakes, polls `listRunnableJobs`, and claims through the identical predicate. A push that arrives twice, late, or on two devices changes nothing: the atomic claim is still the only thing that decides who sends.

Until then, `expires_at` is what keeps a late campaign from going out at the wrong time, and the UI says so.

### 18.10 Build order (proposed, after approval)

1. **Migration** — `clients.status` (§18.3.1) with its default and the active-only list filter; the three `send_jobs` columns, the trigger constraints, the claim predicate, the `expired` status (shared with §16.4.1 if that lands first).
2. **`POST /api/v1/images/upload`** — pasted and attached images, with the type, size and EXIF rules of §18.4.
3. **Wizard steps 4–5** in `shared-ui` — image source picker, schedule and pace screen with the duration estimate.
4. **`jobRunner.ts`** — time-aware `listRunnableJobs`, per-job pacing window, expired handling, the Paused/resume state.
5. **Campaign list** — status, derived progress, cancel — in both shells.
6. **`device_presence`** (§18.6) — the heartbeat, its RLS, and the "last seen" line in the campaign list.
7. **Collision and overlap** (§18.5, §18.7) — the under-20 stagger and the same-day recipient-overlap warning.
8. **Server-side dispatcher** — with §16, not before it.
9. **FCM wake-up** (§18.9), separately.

Test cases get IDs `CAM-*` in `test-plan.md` §21 once this section is approved.

---

## 19. Occasion rules — recurring client notifications

Designed 2026-09-18. Not implemented. Promotes the item deferred in §16.11: *"firm-wide occasion rules ('every client with a birth date who hasn't opted out gets the greeting') instead of a per-client event."*

§16 covers dates a person enters on one matter or one client. This covers the standing instruction — **"every client gets a birthday message at 09:00, forever"** — that nobody should have to re-enter per client. A firm defines the rule once; a scanning job finds who qualifies and materializes the occurrences.

### 19.1 The rule is not the sender

The scanner **materializes `events` and `event_reminders`** (§16.4.3) and stops there. Everything after that is the existing path, unchanged:

```
occasion_rules ──scan──▶ events + event_reminders ──§16.6 dispatcher──▶
    staff notification, or §16.7 client message ──▶ send_jobs ──▶ phone ──▶ WhatsApp
```

This is the whole design decision, and it is worth stating why, because a rule engine that sends directly would be less code today:

- **One delivery path.** Opt-out, `status` (§18.3.1), expiry, approval, the atomic claim and at-most-once delivery are already solved in §16.7 and §15.10. A second sender would have to re-solve every one of them, and would get at-most-once wrong first.
- **The occurrence is visible and editable.** A materialized birthday shows on the calendar three weeks out, can be moved, cancelled, re-worded for one client, or approved — because it is an ordinary `events` row. A rule evaluated at send time is invisible until it fires, which is when it is too late to check.
- **The dispatcher stays one thing.** No new tick, no second claim protocol.

The scanner's only job is deciding **who and when**. It never decides **whether to send**.

### 19.2 Data model

```text
occasion_rules
  id, org_id, created_by
  name                    -- "Birthday greeting"
  occasion                -- birthday | client_since | matter_closed | custom_date
  custom_date_label text  -- occasion = custom_date: which client_dates label
  enabled boolean not null default true
  -- who qualifies
  audience_kinds text[]   -- clients.kind values, default '{client}'
  audience_tags text[]    -- empty = no tag filter; otherwise the client must carry one
  -- when it fires, relative to the occasion date
  lead_days int not null default 0      -- 0 = on the day, 3 = three days before
  at_time time not null default '09:00'
  timezone_source         -- client | firm   (§16.13 D6: client's own if set, else firm's)
  -- what it produces
  audience                -- client | staff
  body_template text      -- client audience; {name} only, as everywhere else
  requires_approval boolean not null default true   -- §16.13 D3
  sender_id uuid          -- client audience: whose WhatsApp. Same rule as event_reminders.
  staff_audience          -- staff audience: assignee | firm_admins
  horizon_days int not null default 30  -- how far ahead occurrences are materialized
  timestamps

client_dates              -- arbitrary dated occasions per client, beyond birth_date
  id, org_id, client_id (composite FK), created_by
  label text              -- "Wedding anniversary", "Company founded"
  date date not null
  recurrence              -- yearly | once
  timestamps
  unique (org_id, client_id, label)

occasion_occurrences      -- the scanner's idempotency ledger
  id, org_id, rule_id (composite FK), client_id (composite FK)
  occasion_date date      -- the occasion itself, e.g. 2027-03-14
  event_id                -- what was materialized (null once the event is deleted)
  created_at
  unique (org_id, rule_id, client_id, occasion_date)
```

`clients.birth_date` already arrives with §16.4.1. `client_dates` covers everything else — anniversaries, retainer dates, whatever a firm tracks — without a schema change per occasion type. `matter_closed` reads `matters.closed_on` and produces one occurrence per closed matter, not per client.

**RLS**: members select `occasion_rules` and `client_dates`; **owner/admin** insert, update and delete rules, because a rule reaches every client in the firm (the same reasoning as §16.13 D5 for templates). `client_dates` follows the `clients` policy — any member may add a date to a client. `occasion_occurrences` is written by the scanner (service role) only; members may read it. A rule with `audience = client` may only be created with `sender_id = auth.uid()`, mirroring `event_reminders`.

### 19.3 The scan

Runs in the §16.6 dispatcher process, **once an hour** rather than every 60 s — occurrences are materialized days ahead, so the scan is never on the delivery path. Per enabled rule, per firm:

1. Compute the window: occasion dates falling between now and `now + horizon_days`.
2. Select qualifying clients: `status = 'active'` (§18.3.1), `suppressed_at is null` for client-audience rules, `kind` in `audience_kinds`, carrying one of `audience_tags` if set, and holding the source date.
3. For each, compute this year's occasion date and the fire time (`occasion_date - lead_days` at `at_time`, in the client's timezone if set and `timezone_source = client`, else the firm's).
4. `insert ... on conflict (org_id, rule_id, client_id, occasion_date) do nothing`. **This is the only thing standing between a job that "keeps scanning" and a client receiving the same birthday message every hour.** The unique index is the guarantee; the scanner's own bookkeeping is not trusted.
5. On a fresh insert, create the `events` row (`recurrence = yearly`, `client_id`, `date_source = projected`) and its `event_reminders` row, which is what the §16.6 dispatcher will pick up.

**29 February** resolves to 28 February in non-leap years — one occurrence per year, never zero, never two (SCH-14 already asserts this for per-client yearly events; the rule path must agree).

**Same-day pile-up.** Forty birthdays on one date would otherwise produce forty `send_jobs` all due at 09:00 — forty single-recipient campaigns colliding, which under C-D3's under-20 rule would each be nudged a minute or two apart and still bunch up. The scanner therefore **staggers** a rule's occurrences that share a fire time, spacing them by the firm's `pacing.min_interval_ms` starting at `at_time`. Forty messages at a 30 s floor span twenty minutes, which is what a person sending them by hand would look like.

### 19.4 Editing a rule, and what does not change retroactively

A rule is a generator, not a live view. Once an occurrence is materialized it is an ordinary event, and it belongs to the firm, not the rule:

- **Disabling or deleting a rule** stops future materialization. Already-materialized occurrences that are `scheduled` are cancelled, and the count is shown before confirming ("this cancels 23 pending messages"). Anything already `sent` is history and is untouched.
- **Editing the body or time** affects occurrences materialized *after* the edit. Pending ones are re-generated only if they have not been approved, and the UI says which.
- **Editing a materialized occurrence** — re-wording one client's message, moving it, cancelling it — is permanent for that occurrence. The next scan must not resurrect it: the `occasion_occurrences` row is the tombstone, and it survives the event's deletion (`event_id` goes null).
- **A client who should never receive a rule's messages** is handled per-client, not by editing the rule: cancelling their occurrence each year is a trap. `clients.suppressed_at` covers "no messages at all"; for "no birthday messages specifically", see O-D2.

### 19.5 Approval, and why it is the default

`requires_approval = true` by default (§16.13 D3). Materialization is silent, but delivery is not: at fire time the sender gets "Birthday message to Fatma is ready" with Review / Send / Skip, and tapping Send is what inserts the `send_jobs` row under normal RLS (§16.7 step 2).

This matters more for rules than for hand-made reminders, because a rule is the one mechanism here that can message people **nobody chose individually**. A firm that turns approval off is choosing automatic outbound messaging to its whole client list; the UI should say that in those words, and §12's framing applies directly.

With approval on, the honest description of the feature is *"it drafts and queues; you tap send"* — which is also what keeps it on the right side of §12.

### 19.6 Interaction with campaigns (§18)

Both end at `send_jobs`, and a client can be in both on the same day. They are not deduplicated, because a birthday message and a firm announcement are different messages and suppressing either silently would be worse. The phone keeps the pacing floor between any two messages whichever job they belong to, and the campaign screen warns before confirming — the same 10 % rule as C-D6, counting a client's scheduled occurrence as an overlapping message.

### 19.7 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **O-D1** | Which occasions ship first | birthday only / birthday + `client_dates` / all four | **Birthday + `client_dates`.** `client_dates` is one small table and covers anniversaries without a second release; `matter_closed` needs its own audience rules. |
| **O-D2** | Per-client exclusion from one rule | a `client_rule_exclusions` table / a reserved tag (`no-birthday`) / cancel each occurrence | **Exclusions table.** A tag is a per-firm convention the system cannot enforce; cancelling annually is a trap (§19.4). |
| **O-D3** | Horizon | 30 days / 90 / per rule | **Per rule, defaulting to 30.** A 3-day-lead birthday needs a week; "anniversary, 30 days before" needs more. |
| **O-D4** | Staff-audience rules in phase 1 | yes / client-only first | **Client-only first.** "Tell me about upcoming birthdays" is a calendar query, not a notification, and the calendar already shows materialized occurrences. |
| **O-D5** | Rule ownership when `sender_id` leaves the firm | disable the rule / reassign to an owner / fail each occurrence | **Disable and notify the owners.** Silently reassigning sends a client's message from a phone the firm did not choose. |

### 19.8 Build order (proposed, after approval)

1. **Migration** — `occasion_rules`, `client_dates`, `occasion_occurrences` with the unique index, RLS and grants.
2. **Scanner** in the dispatcher — window, qualification, idempotent insert, materialization, stagger, leap-year handling. Tested against a clock, not the wall clock.
3. **Rule UI** — list, create/edit under Settings (owner/admin), the disable-with-count confirmation.
4. **Client dates** on the client page.
5. **Exclusions** (O-D2), then further occasion types.

Test cases get IDs `OCC-*` in `test-plan.md` §22 once this section is approved.


---

## 20. Firm numbering — the number wheel

Designed 2026-09-19. Not implemented. **Under review.** Prerequisite of §21, useful on its own.

Matters and clients get their identifying numbers from the system, not from whoever is typing. Today `matters.matter_number` is free text a member types (unique per firm, `matters_org_id_matter_number_key`) and `clients` has no number at all. Free-text numbers collide, drift in format ("2026/14", "M-14", "14/2026"), and cannot be dictated by voice. The firm **owner** defines the format once (the "wheel"); the database hands out the next number.

### 20.1 Decisions taken

| # | Decision | Answer |
| :--- | :--- | :--- |
| **N1** | What is numbered | **Matters and clients.** ("client id" is read as a human-facing `client_number`; the UUID primary key is unchanged.) Tasks are not numbered (N-D1). |
| **N2** | Who defines the format | **The firm owner only** (`org_members.role = 'owner'`), per firm. |
| **N3** | Uniqueness | **Per firm.** Two firms may both have `M-2026-0001`; one firm never has two. |
| **N5** | Related matters | **Sub-numbers** such as `M-2026-0042/01` (§20.10). Decided 2026-09-19. |
| **N4** | Who assigns a number | **The database**, in a `BEFORE INSERT` trigger. Clients never send a number and cannot choose one, unless the owner turns manual entry on (N-D2). |

### 20.2 Data model

```text
org_number_formats
  org_id        uuid   references organizations(id) on delete cascade
  kind          text   check (kind in ('matter', 'client'))
  pattern       text   not null     -- e.g.  'M-{YYYY}-{SEQ:4}'
  reset_period  text   not null default 'never' check (reset_period in ('never', 'yearly'))
  next_seq      bigint not null default 1 check (next_seq >= 1)
  period_key    text                -- the year the counter last ran in; null when reset_period = 'never'
  allow_manual  boolean not null default false
  updated_by    uuid, updated_at timestamptz
  primary key (org_id, kind)

clients.client_number  text          -- new; unique (org_id, client_number)
clients.source         -- check gains 'voice' (§21.6)
```

**Pattern grammar.** Literal text plus tokens `{YYYY}`, `{YY}`, `{MM}`, `{SEQ}` and `{SEQ:n}` (zero-padded to width *n*, 1–10). Exactly one `{SEQ…}`; literal characters limited to `A–Z a–z 0–9 - _ / .`; at most 40 characters rendered. Anything else is rejected by a `check` and by the trigger, so a bad pattern can never reach the allocator.

**Seeded defaults**, for every new firm (trigger on `organizations`) and by backfill for existing ones:

| kind | pattern | reset | example |
| :--- | :--- | :--- | :--- |
| `matter` | `M-{YYYY}-{SEQ:4}` | yearly | `M-2026-0001` |
| `client` | `C-{SEQ:5}` | never | `C-00001` |

### 20.3 Allocation

A `security definer` trigger function (`set search_path = ''`, `revoke execute` from everyone — only the trigger calls it) runs `BEFORE INSERT` on `matters` and `clients` when the number is null:

```sql
update org_number_formats
   set next_seq   = case when period_key is not distinct from :cur then next_seq + 1 else 1 end,
       period_key = :cur
 where org_id = new.org_id and kind = :kind
returning ... ;   -- render pattern, check the firm does not already hold that number, else advance and retry (max 100)
```

- **The row lock is the serializer.** The `UPDATE` locks the firm's counter row until the inserting transaction ends, so concurrent inserts in one firm queue up rather than race. Different firms never contend.
- **Gapless on failure.** The counter moves inside the same transaction as the insert. A failed or rolled-back insert returns its number. A non-member inserting with another firm's `org_id` allocates, is then rejected by RLS, and rolls the counter back with it.
- **Collisions are skipped, not fatal.** If the next rendered number is already taken (a legacy hand-typed number, an import, or the owner lowered `next_seq`), the allocator advances and retries. The unique constraint remains the final guarantee.
- **`{YYYY}` is the UTC year** until firms have a timezone (§16.4.1); then it becomes the firm's year (N-D3).

### 20.4 Immutability and manual entry

With `allow_manual = false` (the default):

- an `INSERT` carrying a non-null number is rejected — for `service_role` too, because the trigger, not RLS, enforces it (same division as `send_jobs_guard()`);
- an `UPDATE` that changes a number is rejected. File numbers are quoted in letters and court papers; they are never re-issued.

With `allow_manual = true`, a member may type a number (validated unique per firm) or leave it blank to auto-assign. Existing rows keep whatever number they have; **changing a pattern or resetting the counter affects only future numbers and never rewrites existing ones.**

### 20.5 Access (RLS)

- `org_number_formats`: members **select**; **owner** insert/update; no delete; no other firm's rows visible (`is_org_member` / `has_org_role(org, '{owner}')`).
- `next_seq` may be raised or lowered by the owner. The UI warns that lowering it only causes collisions to be skipped, never duplicates.
- Members create matters and clients as they do today; they cannot read or touch the counter directly.

### 20.6 UI

**Settings → Firm → Numbering** (owner; read-only for others). One card per kind: pattern field with the token chips, reset period, "next number" field, `Allow manual numbers` switch, and a **live preview** of the next three numbers ("M-2026-0042, M-2026-0043, M-2026-0044") rendered by the same function the database uses (shared renderer, tested for equality with the trigger — NUM-13). Save confirms: "Affects new matters only. Existing numbers are unchanged."

The New matter / New client forms lose their number field (shown read-only after save; "will be assigned" before). Matters and clients lists search by number.

### 20.7 Migration

1. `org_number_formats` + RLS + seed trigger + backfill for existing firms (`next_seq = 1`; the collision skip handles legacy numbers).
2. `clients.client_number`, unique per firm; **backfilled in `created_at` order** so numbering reads chronologically.
3. Triggers on `matters` and `clients`; `matters.matter_number` keeps its `not null` and unique constraint (the `BEFORE` trigger fills it before the not-null check runs).

### 20.8 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **N-D1** | Number tasks too | no / yes | **Decided 2026-09-19: matters and clients only.** Tasks are working items, not files. |
| **N-D2** | Manual override | never / owner switch | **Decided 2026-09-19: owner switch, default off** — some firms have legacy numbering they must continue. |
| **N-D3** | Yearly reset boundary | UTC / firm timezone | **Decided 2026-09-19: UTC now, the firm's timezone once §16.4.1 lands.** |
| **N-D4** | Backfill client numbers | yes / leave null | **Decided 2026-09-19: backfill** in `created_at` order. |
| **N-D5** | Sub-numbering (e.g. `M-2026-0042/01`) | no / later / now | **Decided 2026-09-19: design now** — see §20.10. |

### 20.9 Build order (proposed, after approval)

1. Migration (§20.7) and the allocator, with `NUM-*` offline + `test:live` cases.
2. Shared renderer + Settings → Firm → Numbering screen (owner).
3. Remove the number fields from the matter/client forms; show and search by number.

Test cases: `test-plan.md` §23.

### 20.10 Sub-numbering — related matters

Decided 2026-09-19 (N-D5). A matter can have **related matters** numbered under it: `M-2026-0042` → `M-2026-0042/01`, `/02`, …

```text
matters.parent_matter_id  uuid null      -- composite FK (parent_matter_id, org_id) -> matters (id, org_id) on delete restrict
matters.next_child_seq    int  not null default 1
org_number_formats.sub_pattern  text     -- on the 'matter' row; default '{PARENT}/{SEQ:2}'
```

- **One level only.** A root has no parent; a child cannot itself have children (a trigger rejects a parent that is already a child). Multi-level trees are out of scope.
- **Number.** `{PARENT}` is the parent's number *at creation*; `{SEQ:n}` comes from the parent's own `next_child_seq`. The pattern needs exactly one `{PARENT}` and one `{SEQ…}` and uses the same character set as §20.2. The owner edits `sub_pattern` in Settings → Firm → Numbering; changing it never rewrites existing children.
- **Allocation.** The same `BEFORE INSERT` trigger as §20.3, with a second branch: `update matters set next_child_seq = next_child_seq + 1 where id = new.parent_matter_id and org_id = new.org_id returning …`. The row lock on the **parent** serializes its children; siblings of different parents never contend; the root counter in `org_number_formats` is untouched. Gapless on rollback, and the same collision-skip rule applies.
- **Immutable.** `parent_matter_id` and the assigned number never change after insert — re-parenting is rejected, for `service_role` too (§20.4).
- **Firm boundary.** The composite foreign key means a parent from another firm cannot be referenced.
- **Deletion.** A matter that has children cannot be deleted (`on delete restrict`); the error names the children.
- **UI.** Matter detail shows **Related matters** and a **New related matter** button that prefills the parent; the number preview reads "will be M-2026-0042/03". The list groups children under their parent, and search by number matches either.
- **Assistant and voice.** `create_matter` accepts an optional `parent_matter` **reference**, resolved by the executor (an ambiguous parent drops the action to Ask, §22.4). The model never supplies a number.
- **Migration.** Adds the columns, the trigger branch and the `sub_pattern` default; existing matters are all roots.

---

## 21. Voice matter capture (Android and browser)

Designed 2026-09-19. Not implemented. **Under review.** Needs §20.

> **Amended 2026-09-19 by §22.** Smart mode is replaced by the AI assistant: a voice transcript is simply a prompt to `POST /assistant/runs`. §21.5 (`/matters/voice-draft`), V2's "Smart", V-D6 and V-D8 are superseded; invariant 1 becomes "voice creates only what the autonomy matrix allows, default Ask"; invariant 4 is superseded by §22.5 (the model sees what its read tools return, within the owner's toggles). **Guided mode, §21.3 recognition, §21.6 matching and the §21.7 review screen remain**, the matcher now running in the executor. `create_matter_bundle` is subsumed by the executor's RPCs.

The user speaks; the app produces a **reviewed draft** of a matter — with the clients it concerns and any dates mentioned — and creates it only when the user confirms. Two modes, the user's choice: **Smart** (one description, an AI extracts fields and asks only for what is missing) and **Guided** (the app asks one question at a time, no AI).

### 21.1 Decisions taken

| # | Decision | Answer |
| :--- | :--- | :--- |
| **V1** | Speech-to-text | **On the phone: Android `SpeechRecognizer`.** No CRMEX-side audio upload or transcription provider. See §21.3 for what "on the phone" does and does not guarantee. |
| **V2** | Interaction | **Both, user picks** (§21.4). Smart is the default; Guided is the fallback and always available. |
| **V3** | Languages | **English, Malay, Chinese (Mandarin).** One language per recording, chosen by the user. |
| **V4** | What voice may fill | The matter; **link existing clients by name**; **propose a new client** when none matches; **add follow-up tasks / deadlines / hearing dates.** |
| **V5** | Numbers | **Never spoken, never extracted.** Matter and client numbers are assigned by the database (§20). |
| **V6** | Platform | **Android and Chromium browsers** (decided 2026-09-19, V-D5). Android uses the speech plugin; the browser uses the Web Speech API. Both feed the same assistant and Guided screens through a `speech` capability on `PlatformServices`. |

### 21.2 Invariants

1. **Voice never writes.** Speech only produces a draft. The **review screen is the only write path**, and nothing is saved before the user taps Create.
2. **Audio is never stored or uploaded by CRMEX.** The transcript lives in memory for the session and is discarded on save, on Discard, and when the app is killed. It is not written to `outbox`, SQLite, Supabase or any log.
3. **The extraction endpoint is read-only and stateless.** It calls the LLM and returns JSON. It writes nothing but the per-firm quota counter.
4. **The firm's client list never goes to the LLM.** Clients are matched on the device (§21.5). The model sees only what the user said.
5. **Model output is untrusted input.** It is schema-validated like any request body; it can never carry a number, an id, or SQL, and a transcript cannot cause any action other than proposing a draft.
6. **The firm is verified server-side.** `X-Org-Id` is checked against `org_members`, as on every firm-scoped route (§15.4).

### 21.3 Recognition — and what "on-device" really means

The Android recognizer is a **system service**, not CRMEX code. On the test phone (Huawei P30 Pro, Android 10) it is Google's (`com.google.android.googlequicksearchbox` → `GoogleRecognitionService`, checked 2026-09-19). Two consequences that must be stated plainly:

- **By default the Google recognizer may stream audio to Google's servers.** It stays on the phone only when an offline language pack is installed *and* the request sets `EXTRA_PREFER_OFFLINE`. CRMEX sets that flag, but cannot force it and cannot tell the user which path was taken.
- **Android 13+ (API 33) adds `createOnDeviceSpeechRecognizer()`, which guarantees local recognition. The test phone is API 29 and cannot use it.** So on that phone privacy is best-effort.

Because the content is privileged, the owner gets a firm switch (§21.7): **"Require on-device recognition."** When on, voice is offered only on devices that can guarantee it (API 33+ with the language pack installed) and is hidden elsewhere with an explanation. Off by default (V-D1).

| Locale | Tag | Note |
| :--- | :--- | :--- |
| English | the device's English locale (`en-*`) | |
| Malay | `ms-MY` | |
| Chinese | `zh-CN` (Mandarin) | Cantonese is a separate locale (`zh-HK`/`yue`) — V-D4 |

- **One language per recording.** Switching mid-sentence is not supported; an English case name inside Malay or Chinese speech is often mis-transcribed, so the user corrects it on the review screen. The LLM in Smart mode accepts a transcript in any of the three.
- **Permissions and platform:** runtime `RECORD_AUDIO` (a new manifest permission) and a `<queries>` entry for `android.speech.RecognitionService` (package visibility on Android 11+; the app targets 36). Denied or unavailable → the mic is disabled with the reason and the form stays fully usable by typing.
- **Plugin (V-D2):** `@capacitor-community/speech-recognition` 7.0.1 declares `@capacitor/core >=7`; this app is on Capacitor 8.5.2, so it must be proven in a spike. If it is not compatible, **stop and ask**: V-D2 was decided as community plugin only, so a custom Java plugin would be a new decision.
- **Testing:** the emulator has **no Google recognition service**, so speech can only be tested on the physical phone.
- **Browser (V-D5):** the Web Speech API (`SpeechRecognition`, Chromium-based browsers over HTTPS or localhost). **Audio is always sent to Google's servers and there is no on-device option**, so when the owner's `voice_require_on_device` is on, browser voice is hidden with an explanation. The mic is hidden where the API is missing (Firefox, Safari); a denied mic permission falls back to typing. Same three languages via the `lang` setting; same one-language-per-recording rule.

### 21.4 The two modes

Entry point: Matters → **New matter** → a **Voice** button beside the form; a per-user preference remembers the last mode. Smart falls back to Guided automatically, with a one-tap prompt, when the device is offline, the firm's daily voice quota is spent, or extraction fails twice.

#### Smart

1. Prompt: *"Describe the matter — who it's for, what it's about, and any dates."* Language chips (EN · BM · 中文) sit above the mic.
2. The transcript streams onto the screen and stays **editable**. When recognition stops (the recognizer ends on silence), the user can continue or send.
3. `POST /api/v1/matters/voice-draft` returns the updated draft, a list of what is still `missing`, and one follow-up `question` in the user's language.
4. The question is shown as text (spoken aloud only if the user turned on the speaker, V-D3) and the mic reopens. **At most 4 follow-up turns**, then the app goes to review with the gaps left blank. **Skip to review** is always available.

#### Guided

Fixed order, one card per question, **no server call** — so it works offline and when quota is exhausted:

| Step | Voice does | Input |
| :--- | :--- | :--- |
| Who is the client? | dictate a name → local match → pick chips | may add several, with roles |
| Matter title | dictated verbatim into the field | text |
| Practice area | — | chips (the firm's existing values + Other) |
| Any hearing or deadline? | — | **date picker** |
| Notes | dictated verbatim | text |

**Guided does not parse spoken dates or categories.** Understanding "third of March" or "bulan depan" or "下周二" in three languages needs the model; Guided deliberately does not, and uses pickers instead.

### 21.5 Server: `POST /api/v1/matters/voice-draft`

Firm-scoped (`requireOrgMember`), next to `/messages/draft`, mounted with the same quota pattern (`orgUsageRepo`, limits read from `app_settings`, e.g. `voice.drafts_per_day`).

```text
request   { transcript, language: 'en'|'ms'|'zh', today: 'YYYY-MM-DD', timezone?,
            draft?: <previous draft>, turn: 1..5 }
limits    transcript <= 4000 chars; turn <= 5; body size capped
response  { draft: {
              title: string|null, practice_area: string|null,
              status: 'open'|'pending'|null, opened_on: 'YYYY-MM-DD'|null, notes: string|null,
              clients: [{ spoken_name, role: 'client'|'opposing_party'|'witness'|'other' }],
              tasks:   [{ title, kind: 'task'|'deadline'|'hearing', due_on: 'YYYY-MM-DD'|null }] },
            missing: ('title'|'clients'|'practice_area')[],
            question: string|null }
```

- **Validated with zod on the way out**, the same as the drafter's input. Unknown keys are dropped; a number, id or non-ISO date is rejected; `tasks` is capped (e.g. 10) so a transcript cannot spawn dozens.
- **Relative dates** ("next Tuesday") are resolved against the `today` the client sends; an ambiguous date returns `null` and becomes the follow-up question rather than a guess.
- **Prompt injection:** the transcript is data. The route has no tools and no side effects, so the worst outcome of a hostile transcript is a schema-valid but wrong draft — which the review screen exists to catch.
- **No bodies in logs.** The route does not log the request, and provider errors are mapped to a generic code exactly as `/messages/draft` does today.
- Errors follow the existing codes (`LLM_ERROR`, `PROVIDER_TIMEOUT`, quota) so the app can offer Guided.

### 21.6 Resolving clients (on the device)

For each `clients[].spoken_name` the app compares against the firm's clients, in `shared-ui`:

- Normalize case, diacritics and whitespace; strip Malay honorifics (*Encik, Puan, Dato', Datuk, Tan Sri, bin/binti* handled as name particles); match Chinese names by exact and substring.
- **Strong match → preselected. Several close → a pick list. None → a "Create new client" draft** (display name only, `source = 'voice'`, kind chosen from the role — e.g. `opposing_counsel`). The app **never auto-picks an ambiguous match and never auto-creates**; every mention needs an explicit choice on the review screen.
- A client created this way gets its `client_number` from §20 like any other, and is subject to §12 exactly like a manual one (no phone → cannot be messaged anyway).

### 21.7 Review, create, and firm settings

**Review screen** (the write gate, invariant 1):

- *Matter* — the number is shown as "will be assigned: M-2026-0042" (read-only, §20.6), then title, practice area, status, opened date, notes.
- *Clients* — each mention shows its matched client with alternatives, or the new-client draft, or **Skip**, plus a role.
- *Tasks* — each proposed task with kind and date, each individually switchable.
- *Transcript* — collapsible, editable, with **Re-run**.
- Fields the model left `null`, and matches that were not strong, are visually marked. Actions: **Create**, **Back to talk**, **Discard** (wipes the transcript).

**Create** calls one Postgres function, `create_matter_bundle(p jsonb)`, `security invoker` (so RLS applies per table exactly as if the user had made each insert by hand), in a **single transaction**: new clients → matter → `matter_clients` → tasks. It is **all-or-nothing** and returns the created ids and the assigned numbers. The client supplies the matter's UUID up front as an idempotency key: repeating the call after a dropped connection or double tap returns the existing matter and never creates a second. The composite foreign keys (`matter_clients`, `tasks`) already reject a client or matter from another firm.

**Firm settings** (owner, new `org_settings` table, defaults in brackets): `voice_smart_enabled` [true] — off means Guided only and the endpoint refuses that firm, for firms that will not send transcripts to an LLM provider; `voice_require_on_device` [false] — §21.3.

### 21.8 Privacy summary

| Data | Where it goes |
| :--- | :--- |
| Audio | The Android recognizer service only. Possibly Google's servers unless offline recognition applies (§21.3). Never CRMEX. |
| Transcript, Guided mode | Stays on the phone until the user saves what they chose to save. |
| Transcript, Smart mode | Sent to `core-server` and on to the LLM provider under the existing provider terms. Not stored, not logged. Owner can disable Smart. |
| Client list | Never leaves the phone for matching; the LLM does not receive it. |

### 21.9 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **V-D1** | Recognizer privacy | accept best-effort `PREFER_OFFLINE` / require guaranteed on-device (API 33+ only) | **Decided 2026-09-19: best-effort by default with the owner's "require on-device" switch.** Requiring it everywhere would disable voice on the current test phone. |
| **V-D2** | Plugin | community plugin / custom Java plugin | **Decided 2026-09-19: community plugin only.** Spike it first; if it does not work on Capacitor 8, stop and ask — no custom plugin without a new decision. |
| **V-D3** | Read follow-up questions aloud | text only / spoken | **Decided 2026-09-19: text, with a speaker toggle default off** — reading privileged questions aloud in public is a leak. `@capacitor-community/text-to-speech` 8.0.2 targets Capacitor 8; Google TTS is present on the test phone. |
| **V-D4** | Cantonese | Mandarin only / also `zh-HK` | **Decided 2026-09-19: Mandarin only** unless a firm needs it. |
| **V-D5** | Browser voice | none / Web Speech API | **Decided 2026-09-19: yes, via the Web Speech API in Chromium browsers.** Audio always goes to Google there; the owner's on-device-only switch hides it (§21.3). |
| **V-D6** | Who writes the follow-up question | the LLM in the user's language / canned per-field questions | **Superseded 2026-09-19 by §22:** the assistant's model writes it; Guided stays deterministic. |
| **V-D7** | Provenance of voice-made clients | `source = 'voice'` / `'manual'` | **Decided 2026-09-19: `'voice'` for any client created through voice or the assistant**, one added check value. The name is broader than "spoken", by choice. |
| **V-D8** | Quota | share `draft` quota / own `voice.drafts_per_day` | **Superseded 2026-09-19 by §22:** voice uses the assistant quota (`agent_turns`, per firm with a per-user share). |

### 21.10 Build order (proposed, after approval)

1. **Speech spike** on the P30 Pro: plugin compatibility with Capacitor 8, `RECORD_AUDIO` + `<queries>`, English/Malay/Mandarin transcripts, `PREFER_OFFLINE` behaviour with airplane mode on. Gate for the rest.
2. **§20 numbering** (the review screen shows the assigned number).
3. **`create_matter_bundle`** RPC + `clients.source` value + `org_settings`.
4. **Guided mode** in `shared-ui` (no server), client matcher, review screen.
5. **`POST /matters/voice-draft`** + quota + schema, then **Smart mode**.
6. Owner settings screen.

Test cases: `test-plan.md` §24.


---

## 22. AI assistant — server-side agent on gyrfalcon

Designed 2026-09-19. Not implemented. **Under review.** Builds on §17 (gyrfalcon integration) and **amends** it (§22.13). Replaces §21's Smart mode: voice becomes the microphone on the assistant.

Wherever the product needs AI beyond a single short call, the phone sends a **prompt** to `core-server`; `core-server` runs the request through **gyrfalcon** and turns the agent's answer into **real records** — clients, matters, tasks, hearings, message drafts, send jobs — according to a per-action policy the firm owner sets. The phone then shows what was created. **There is no separate "mini harness":** gyrfalcon is the only agent engine, and `core-server` is the API, the policy layer and the only writer.

### 22.1 Decisions taken

| # | Decision | Answer |
| :--- | :--- | :--- |
| **A1** | Agent engine | **Gyrfalcon only.** `core-server` forwards; no second agent loop. Everything goes through the §17.3 `AgentEngine` adapter, with a `fake` for offline tests. |
| **A2** | Who writes | **`core-server`, never gyrfalcon.** Gyrfalcon returns a structured **plan**; `core-server` validates it and executes or stages each action (§22.4). |
| **A3** | Reads | **Read tools call back into `core-server`** (§22.5). Writes never do. |
| **A4** | Commit policy | **Per-action autonomy, Ask or Auto, set by the owner.** Every action type can be Auto, including outbound sends, bounded by the outbound cap (A5). Default for everything except drafts is **Ask**. |
| **A5** | Outbound cap | **50 messages per firm per day by default.** The owner may lower it; the operator sets the ceiling. Counts recipients, not jobs. Past the cap an Auto action falls back to Ask. |
| **A6** | Uncertainty | **Never guess.** An ambiguous match, a near-duplicate, or an unclear date makes *that action* drop to Ask; the rest of the plan proceeds. |
| **A7** | Deletes | **None, ever.** The catalog has no delete. Cancelling a queued job is an update. |
| **A8** | Reversibility | Every write is logged with before/after and has a one-tap **Undo for 24 h** (§22.6). Sent WhatsApp messages cannot be unsent; the log says so. |
| **A9** | Models | **The operator's allow-list lives in `app_settings` (`agent.models_allowed`); the owner picks one per firm** (amended 2026-09-19 from an env list). `core-server` sends the chosen model with each run; **provider keys stay in one server env and are never sent to a client or shown in any UI** (§22.9). |
| **A10** | System prompt | **Controlled by the SaaS operator** (e.g. law-firm topics only). Layered above firm and member instructions; lower layers may narrow, never widen (§22.7). Off-topic gets a fixed refusal. |
| **A11** | Memory | **Per-user rolling session per firm, kept *N* days**; the owner sets *N* (default 30). Nothing is shared between members. |
| **A12** | Kill switch | **Two, either one stops all AI:** the firm owner (their firm) and the SaaS admin (everyone). The app is told which one, and says so (§22.8). |
| **A13** | Live delivery | **SSE for the assistant's text; Supabase Realtime for the rows** (drafts, records, run status). |
| **A14** | Read scope | Clients (names, kind, tags, notes), matters and tasks (incl. notes), message-history bodies, images and files. **Each class has an owner toggle** (§22.6). |
| **A15** | Entry points | Floating assistant button on every main screen; the assistant sheet inside Messages Compose; contextual on matter and client detail; **"New by voice"** on the Clients, Matters and Tasks lists. |
| **A16** | Background jobs | Agent runs may be long-running. Results land in an **in-app inbox with a badge only** — no push and no local notification for agent runs (decided 2026-09-19, §22.10). |
| **A17** | Voice | **Merged.** A voice transcript is just a prompt. The dedicated voice-draft endpoint is dropped; §21 Guided mode stays as the no-AI fallback. |

### 22.2 Architecture

```text
phone/browser ──HTTPS + Supabase JWT + X-Org-Id──▶ core-server ──(private)──▶ gyrfalcon
   ▲   SSE (text) ◀────────────────────────────────┤  │  ▲                        │
   │   Realtime (rows) ◀── Supabase ◀───────────────┘  │  └── read-tool callbacks ─┘
   │                                                    ▼        (run-scoped token)
   └─────────────────────────────────────────────── Supabase (authoritative)
```

Per request, `core-server`:

1. verifies the JWT and `X-Org-Id` against `org_members` (§15.4);
2. evaluates the **kill switches** and **quota** (§22.8) — before any gyrfalcon call;
3. builds the **layered prompt** (§22.7), picks the **model** (§22.9), mints a **run-scoped token**;
4. inserts `agent_runs` and calls `startChatTurn`;
5. relays text over SSE, lets gyrfalcon call the read tools, receives the **plan**;
6. validates the plan and runs the **executor** (§22.4);
7. writes `agent_actions` / `agent_proposals`, which the phone receives over Realtime.

### 22.3 The assistant, from the phone

- **Prompt in, records out.** The app sends `{message, sessionId?, context, language}` where `context` says where the user is (`screen`, and the active `matterId` / `clientId` / `draftId` if any). The context carries **ids only**; `core-server` loads whatever the agent needs.
- **What appears.** Assistant text streams into the sheet. Each executed or staged action shows as a **result card** — *"Created client Fatma Ali · C-00214 · Open"*, *"Matter M-2026-0042 ready — Confirm"* — with Undo (Auto) or Confirm / Reject (Ask). The app navigates to the created record when the user taps it; lists refresh through the existing `bump()` mechanism and Realtime, so **the phone pulls out what the server just created** rather than being handed it.
- **Voice** is the mic beside the text box (§21.3 recognition unchanged). A recording becomes the prompt.
- **Guided voice** (§21.4) is untouched: no AI, no server call.

### 22.4 Plan and executor

Gyrfalcon's structured result:

```text
{ summary: string,
  actions: [ { id, type, args, depends_on: [id], rationale } ],
  questions: [ string ]            // shown when the plan needs an answer to continue
}
```

**Action catalog and defaults.** The set is closed: gyrfalcon cannot invent an action, and there is no delete (A7).

| Action `type` | What it does | Outbound? | Default |
| :--- | :--- | :--- | :--- |
| `draft_message` | create or update a `message_drafts` row (§23.1) | no — never sends | **Auto** |
| `create_client` / `update_client` | clients | no | Ask |
| `create_matter` / `update_matter` | matters (number auto-assigned, §20) | no | Ask |
| `link_client_to_matter` | `matter_clients` with a role | no | Ask |
| `create_task` / `update_task` / `complete_task` | tasks, deadlines, hearings | no | Ask |
| `queue_send` | insert a `send_jobs` row now | **yes** | Ask |
| `schedule_campaign` | `send_jobs` with schedule and pace (§18) | **yes** | Ask |
| `cancel_send_job` | cancel a batch (§23.4) | no | Ask |
| `start_background_run` | start a long-running agent run (§22.10) | no | Ask |

**Executor** (`core-server/src/agent/executor/`, deterministic code, no LLM):

1. **Validate** every action with a per-type `zod` schema. Ids are never taken from the model: references to existing records are resolved by the executor (e.g. a spoken client name → the §21.6 matcher), and the result is re-checked against the firm.
2. **Resolve ambiguity** per A6. Two similar clients, a name that nearly matches an existing client, or an ambiguous date sets that action to `ask` regardless of the matrix.
3. **Apply the matrix.** `auto` → execute now; `ask` → insert `agent_proposals(status='pending')` and notify.
4. **Enforce the outbound cap** on `queue_send` / `schedule_campaign`: recipients counted against the firm's day; over the cap → `ask` with the reason shown. Opt-out, client `status`, phone presence and `limits.max_batch_recipients` apply exactly as in §12 / §18.7 — the executor does not bypass any of them.
5. **Execute** in `depends_on` order through **`security invoker` RPCs** (the same approach as §16's `apply_move`), so RLS still bounds what a member could have done by hand. Each action gets an idempotency key `hash(run_id, action.id)`; a retry cannot duplicate.
6. **Log** one `agent_actions` row per action (§22.6). A failed action is reported, not silently retried; actions that already succeeded are not rolled back automatically — the user sees the partial result and can Undo any of them.

Accepting a staged proposal (`POST /assistant/proposals/:id/accept`) runs the *same* executor path as the user, with the same validation — the server, not the phone, commits it.

**Authority for background runs** (AG-D1): a run that outlives the user's JWT executes with the service role, **re-verifying membership and the action's policy at execution time, stamping `created_by = run.user_id`, and filtering every query by `org_id`** — the rule already applied to the retention job and the §16 dispatcher.

### 22.5 Read tools

`/internal/agent-tools/read/*`, called by gyrfalcon with the **run-scoped token** (bound to `(org_id, user_id, run_id)`, ~15 min, revoked at run end, never accepted for a write). `core-server` resolves the firm from the token, never from arguments.

`search_clients`, `get_client`, `list_matters`, `get_matter`, `list_tasks`, `search_messages`, `get_image` (metadata only; signed URLs never leave `core-server`).

- Every result is **capped** (rows and characters) and filtered by `org_id`.
- **Phone numbers and emails are excluded** unless the owner allows them.
- The owner's **read-scope toggles** (§22.6) remove whole classes. Notes and message bodies contain privileged content and go to the LLM provider under its terms; the toggles exist so a firm can keep them out.
- **Retrieved text is untrusted.** Notes, messages and client names are wrapped as data, and a plan is validated the same way whatever the source of the instruction (§22.11).

> This **supersedes §21 invariant 4** ("the firm's client list never goes to the LLM"). What the model can see is now what its read tools return, within the owner's toggles.

### 22.6 Data model and the Agent setup

```text
org_agent_settings       -- one row per firm; members select, OWNER inserts/updates
  org_id, enabled boolean, model text,
  autonomy jsonb,          -- { create_client: 'ask'|'auto', ... } — missing key = default
  outbound_cap int,        -- <= operator ceiling
  read_scope jsonb,        -- { clients, matters_tasks, message_bodies, images, contact_details }
  enabled_tools text[], instructions text (<= 2000 chars),
  limits jsonb,            -- { turns_per_day, max_steps_per_run, max_tokens_per_run }
  memory_days int default 30, transcript_days int default 30,
  updated_by, updated_at

user_agent_prefs         -- per (user, org); the user reads/writes only their own row
  user_id, org_id, reply_language, verbosity, speak_replies boolean, notify boolean

agent_runs               -- §17.3: firm-scoped; members read; core-server writes
  + user_id, kind ('chat'|'background'), session_ref, status, model, error, timestamps

agent_proposals          -- §17.3: staged Ask actions; members read; core-server writes
agent_actions            -- new: one row per executed/staged action
  id, org_id, run_id, type, target_table, target_id, auto boolean,
  before jsonb, after jsonb,               -- what changed, for Undo
  status ('applied'|'undone'|'failed'), undo_expires_at, decided_by, decided_at

message_drafts, message_draft_versions   -- §23.1
```

RLS: everything firm-scoped; `org_agent_settings` writable only where `has_org_role(org, '{owner}')`; the operator has **no** read of any of it (§13.2 / §15.8). `agent_actions` contains client data in `before`/`after`, so it follows the same firm boundary as the records themselves.

**Undo** (`POST /assistant/actions/:id/undo`, `security invoker` RPC): restores `before` for an `applied` update, and removes a create that has no dependents, **within 24 h** and only if the record has not been edited since (otherwise it explains and offers the manual path). It may be run by the run's user, or by an owner/admin. Undo of an outbound action is **not offered**: the card says "already queued — cancel the batch instead" / "sent messages cannot be unsent".

**Agent setup menu** — *design only, not built.* Settings → **AI assistant**:

```text
┌─ AI assistant ───────────────────────────┐
│ AI is ON                          [ON/OFF] │  owner. Read-only text if the operator turned AI off.
│ Model            [ provider · model ▾ ]    │  choices come from the server's env allow-list
├─ What it may do on its own ───────────────┤
│ Create / update clients        [Ask ▾]     │  Ask | Auto, per action type
│ Create / update matters        [Ask ▾]     │
│ Tasks, deadlines, hearings     [Ask ▾]     │
│ Draft messages                 [Auto ▾]    │
│ Send or schedule messages      [Ask ▾]     │  outbound
│   Daily outbound cap           [ 50 ]  (max 100 set by the platform)
├─ What it may read ────────────────────────┤
│ Clients · Matters/Tasks · Message text · Images · Phone numbers/emails
├─ Tools ───────────────────────────────────┤
│ each capability switchable
├─ Firm instructions ───────────────────────┤
│ free text, 2000 chars — narrows behaviour, cannot override the platform policy
├─ Limits, memory, retention ───────────────┤
│ Turns / day · Steps / run · Remember chats for [30] days · Keep transcripts [30] days
└────────────────────────────────────────────┘
Members see: language · verbosity · read replies aloud · notifications
```

### 22.7 The prompt, in layers

1. **Operator system prompt** — key `agent.system_prompt` in `app_settings` (seeded default: law-firm practice management only; the assistant declines other topics). Set by the SaaS admin; **never editable or visible to a firm**; versioned. It never contains firm data.
2. **Firm instructions** — owner text from `org_agent_settings.instructions`; may narrow, never widen; cannot enable a tool or raise a limit.
3. **Member preferences** — reply language, verbosity.
4. **Run context** — the ids and the pushed data for this screen.

**Off-topic:** the operator prompt tells the model to answer an out-of-scope request with a fixed marker; `core-server` replaces it with a **fixed, localized refusal string** and produces no plan. The refusal wording is not model-improvised. (A pre-check classifier was considered and rejected: it adds a component that can misclassify legitimate legal work.)

### 22.8 Kill switches, quotas, and telling the user

**Effective state = operator switch AND firm switch AND (not over quota).** Either switch off means no gyrfalcon call, no run, no tool token.

- Operator: `app_settings` key `agent.enabled`. Firm: `org_agent_settings.enabled`. **New firms start ON** (decided 2026-09-19); the owner can turn AI off at any time. Because privileged content goes to an LLM provider, the first use by each member shows a one-time notice of what is sent (and that the owner can turn it off) — informational, not a gate (AG-D3).
- `GET /api/v1/assistant/status` → `{ enabled, disabledBy: 'operator'|'owner'|null, reason?, quotaRemaining }`. Any assistant call while disabled returns a stable code `AI_DISABLED` with the same `disabledBy`.
- **The app must say so**, not fail silently: the assistant button stays visible but shows *"AI is turned off by your firm owner"* or *"AI is temporarily unavailable"*. Manual entry, Guided voice and the composer keep working.
- **Flipping a switch stops in-flight work:** the run-scoped tokens are revoked and running runs are cancelled; staged Ask proposals remain (a human can still accept or reject them) unless the owner rejects them.
- Quotas (`org_usage_daily`, §13.5): `agent_turns`, `agent_tokens`, `outbound_auto`, checked before any gyrfalcon call; limits are the owner's, capped by operator ceilings (`agent.*_ceiling` in `app_settings`).

### 22.9 Models and keys

- **`app_settings`** holds the allow-list (`agent.models_allowed`, `provider:model` entries) and `agent.default_model`; **the provider keys stay in the one shared server env** (`ANTHROPIC_API_KEY`, …). A listed model whose provider key is missing is rejected when the operator saves the list and skipped at run time, so a firm can never be set to a model the server cannot call.
- The owner picks from the list in Agent setup; nothing else can be entered. `core-server` passes the chosen **model and generation settings with each run**; it does not send keys to the client, and does not put them in prompts or logs.
- This needs **a per-run model override in gyrfalcon** (G7, §22.13) — §17.1 does not say it exists. Until then, a fixed model configured in gyrfalcon is the fallback, and the firm's choice is stored but has no effect.

### 22.10 Background runs and the inbox

A `background` run is started by the user ("do this in the background"), by an Ask→accept, or later by the §16 dispatcher. It has a hard **step and time limit** from the owner's settings (bounded by operator ceilings).

- **Progress and result** land in `agent_runs` / `agent_actions` (Realtime) and a **`notifications` inbox row** (§16.4.3) with a badge. Inbox text is **minimal** — no client names (§16.6.2).
- **Inbox only (AG-D5, decided 2026-09-19).** There is **no push and no local notification** for agent runs: results are seen when the app is opened, and the UI says so. (FCM for campaigns, §18.9, is a separate deferred item and is unaffected.)

### 22.11 Security

- **Auto is the blast-radius decision, so the guards are structural:** the closed action catalog; no deletes; the outbound cap; A6 (uncertainty → Ask); idempotency keys; all writes through RLS-bounded RPCs; the existing opt-out, `status`, phone and batch-size checks re-applied by the executor.
- **Prompt injection.** Client notes, message bodies and names read by the agent may contain instructions. They are passed as delimited data, and the executor treats the plan as untrusted regardless of source. The worst outcome is a wrong plan the matrix then stages (Ask) or — for an action the owner set to Auto — applies and logs with Undo. The outbound cap bounds the outbound case.
- **Gyrfalcon holds no credentials into CRMEX data** except the short-lived run-scoped token, valid for read tools only.
- **Tenancy inside gyrfalcon** follows §17.4 (option C in dev, option A before any real firm data).
- **No bodies in logs**; provider errors map to generic codes as `/messages/draft` does.
- **Operator boundary (§15.8):** the operator sees no `agent_runs`, no transcripts and no actions; only aggregate config. Gyrfalcon's dashboard stays unreachable to operators (G-D6).
- **Retention:** transcripts deleted after `transcript_days` via gyrfalcon's delete APIs (G6); `agent_actions.before/after` follow the retention setting.

### 22.12 Endpoints

```text
GET  /api/v1/assistant/status
POST /api/v1/assistant/runs                 { message, sessionId?, context, language } -> { runId }
GET  /api/v1/assistant/runs/:id/events      SSE: text deltas, tool names (never arguments), plan summary, action states
GET  /api/v1/assistant/runs/:id
POST /api/v1/assistant/runs/:id/cancel
POST /api/v1/assistant/proposals/:id/accept | reject
POST /api/v1/assistant/actions/:id/undo
GET|PUT /api/v1/assistant/settings          owner writes; members read; validated against operator ceilings and the env allow-list
GET|PUT /api/v1/assistant/prefs             the caller's own row
/internal/agent-tools/read/*                run-scoped token only, never a user JWT
```

All under `requireOrgMember` except `/internal`. Firm-scoped refs (`runId`, `proposalId`, `actionId`) are loaded filtered by the verified `org_id` first, so a guessed id is a 404 before gyrfalcon or any write is reached (§17.3).

### 22.13 Amendments to earlier sections

- **§17.2 rule 3** ("agents never write") is **narrowed**: *gyrfalcon* never writes; `core-server`'s executor writes, per the owner's autonomy matrix, with Ask as the default.
- **§17.10 G-D2**: stage 2 is now **read tools only**, and is **required**, not optional. **G4 (per-call credential injection) and G2 (tenant assertion) are therefore prerequisites** for any real firm data. Dev may use the single `LOCAL` principal.
- **New gyrfalcon change G7:** per-run model/provider override, per-run system prompt, and structured-output (plan) enforcement. To be confirmed against gyrfalcon's code.
- **§21:** Smart mode, §21.5 (`/matters/voice-draft`), V-D6 and V-D8 are **superseded**; §21 invariant 1 ("voice never writes") becomes "voice creates only what the autonomy matrix allows, default Ask"; invariant 4 is superseded by §22.5. Guided mode, §21.3 recognition and §21.6 matching remain (the matcher now runs in the executor).

### 22.14 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **AG-D1** | Authority for runs that outlive the JWT | service role + re-verification / re-mint a user token | **Decided 2026-09-19: service role with re-verification**, stamped `created_by` (§22.4). |
| **AG-D2** | Default matrix | all Ask except drafts / more Auto | **Decided 2026-09-19: all Ask except `draft_message`.** |
| **AG-D3** | AI default for new firms | off until owner enables / on | **Decided 2026-09-19: on by default**, with the one-time notice of §22.8 and an owner off-switch. |
| **AG-D4** | Operator ceilings, seeded | outbound / turns / steps / tokens | **Decided 2026-09-19: the tighter set — outbound **100/day**, turns **50/user/day**, steps **10/run**.** The owner's default outbound cap stays 50; adjustable later in the portal. |
| **AG-D5** | Completion alert when the app is closed | inbox on next open / FCM | **Decided 2026-09-19: inbox only, never push** (§22.10). |
| **AG-D6** | Session length | rolling until idle *N* days / per-conversation | **Decided 2026-09-19: rolling per (user, firm), idle-expiry = `memory_days`.** |
| **AG-D7** | Quota unit | per user / per firm | **Decided 2026-09-19: per firm, with a per-user share** so one member cannot exhaust it. |
| **AG-D8** | Undo window | 24 h / owner-set | **Decided 2026-09-19: 24 h, fixed.** |
| **AG-D9** | Model allow-list format | env list / `app_settings` | **Decided 2026-09-19: `app_settings`** (this reverses the earlier env-list choice; keys stay in env, §22.9). |

### 22.15 Build order (proposed, after approval)

1. **Adapter + fake, migrations** (`org_agent_settings`, `user_agent_prefs`, `agent_runs`, `agent_proposals`, `agent_actions`), kill switches, `/assistant/status`, and the RLS + live tests.
2. **Settings API and the Agent setup screens** — design here; built after the API.
3. **Read tools** (needs gyrfalcon G4; dev on `LOCAL`) and the **plan executor** for the data-entry actions, with A6 and the action log.
4. **Assistant sheet** on Android: SSE, result cards, Undo, entry points.
5. **Voice into the assistant** (§21 Guided remains).
6. **Outbound actions** and the outbound cap.
7. **Background runs** and the inbox.
8. Gyrfalcon **G2, G7, G1, G6**, then tenant assertion before real data.

Test cases: `test-plan.md` §20.

---

## 23. Messaging composer, drafts, schedule step and batch cancel

Designed 2026-09-19. Not implemented. **Under review.** Extends §18 (campaigns) and amends its cancel rule.

### 23.1 Where a draft lives

**The server creates and holds the draft; the phone renders it and patches it.** A `message_drafts` row is the source of truth, so a draft survives an app kill, opens on the browser, has an audit trail, and can be filled by the assistant.

```text
message_drafts     -- firm-scoped; the creator reads and writes; the firm OWNER may read (not edit) (MSG-D7)
  id, org_id, created_by, status ('draft'|'submitted'|'discarded'),
  body, media_path,
  audience jsonb,             -- { filter | client_ids, query?, excluded: {...counts} }
  schedule jsonb,             -- { scheduled_at?, interval_ms?, jitter_pct, expires_at? }  (§18.3.2)
  version int, last_edit_by ('user'|'agent'), send_job_id?, timestamps,
  edit_lock_device text, edit_lock_expires_at timestamptz   -- the edit lease (below)

message_draft_versions   -- last ~20 versions per draft: (draft_id, version, body, audience, schedule, edit_by, at)
```

- **Not sent by drafting.** A draft is inert. Submitting it inserts a `send_jobs` row (§15.10 / §18); a draft never causes a send on its own.
- **Populate, don't wait.** The screen renders the agent's edits as they stream and **patches the row optimistically**, debounced (~700 ms). Each patch carries the draft `version` as a safety check.
- **One device edits at a time (MSG-D2, decided 2026-09-19).** Opening a draft takes an **edit lease** (`edit_lock_device`, `edit_lock_expires_at`): 2 minutes, renewed every 30 s while the screen is open. A second device opens the draft **read-only** with *"Being edited on another device — Take over"*. Take over moves the lease; the first device becomes read-only on its next patch. **The lease expires by itself**, so a dead phone cannot hold a draft. While a device holds the lease, **the assistant's edits arrive at that device as a diff to accept** rather than being written; with no lease held, the assistant writes a new version directly (still undoable).
- **The user's edit is authoritative.** The agent always works from the latest version; if the version changed during a run, its change arrives as a **visible diff** the user accepts or rejects — never a silent overwrite. Each agent edit is a version, so **Undo** per field and **Undo all** are simple.
- Drafts idle for 30 days are purged by the retention job.

### 23.2 The composer: three stops, one editing surface

A stepper **Compose · Schedule · Review** across the top; the assistant (✦) is available on every stop.

**1 · Compose** — one screen with cards:

- **To** — count and filter chips, or a natural-language query (§7.4); the excluded line names each reason separately (opted out · inactive · no phone, §18.3.1). *Change* opens selection (Select all matching, §18.4).
- **Message** — editable text with `{name}`, **Preview as** a chosen recipient, and rewrite chips (shorter · friendlier · translate to BM / EN / 中文). Assistant edits appear highlighted with **Undo**.
- **Image** — none · generate/search (§8) · paste/attach (§18.4).

**2 · Schedule** (the added step) — Send now or **Later** (date and time in the firm's timezone); the pace preset (10 s / 30 s / 60 s / custom, floored by `pacing.min_interval_ms`) and jitter; the **late window** (default 6 h). It shows the arithmetic — *"412 recipients · every 30 s (±25 %) · starts Fri 09:00 · finishes ≈ 12:26"* — the notice *"3 recipients also have a scheduled message today"* (§19.6), which phone will send it and when it was last seen, and *"your phone must be online and running CRMEX for the whole run"* (§15.10).

**3 · Review** — the final summary and the existing two-tap `SendConfirmation` gate with the recipient count. **Confirm & schedule** or **Send now**.

**Leaving the wizard** (Back / Close at any stop) asks **Save draft · Discard · Keep editing**. Nothing is ever sent by leaving. A saved draft appears under Messages → Drafts and resumes at the stop where it was left.

### 23.3 Finding a batch

The **Messages** tab has three segments — **Drafts · Scheduled · History** — and a search bar with filters:

- **Status:** scheduled · running · done · cancelled · failed · expired (scheduled and running listed first, since they are cancellable).
- **Message text** (words in the body).
- **Recipient** (client name or number) — answers *"did Fatma get this?"* by finding batches whose recipients include her.
- **Date range** and **creator**.

Everything is firm-scoped by RLS. Implementation: `send_jobs (org_id, status, scheduled_at)`, a GIN index on `recipients` for recipient lookup, and a text index on `body` (trigram vs `ilike`, MSG-D6). A **batch detail** screen shows status, schedule, pace, per-recipient results (derived from `message_history` rows with `batch_id = job.id`, §18.5), a timeline, **Cancel batch** when allowed, and **Duplicate as draft**.

### 23.4 Cancelling a batch — supersedes §18.6

**Who:** the batch's **creator, and firm owners and admins**, from the phone or the browser. Members cannot cancel other members' batches.

**What "cancel completely" means:** *stop everything not yet sent.* WhatsApp messages already delivered cannot be unsent, and the UI says so plainly: *"130 sent · 282 will not be sent."*

| Batch state | Cancel does | Result |
| :--- | :--- | :--- |
| `queued` / scheduled | `queued → cancelled` immediately, via `cancel_send_job(id)` (`security invoker` RPC, so the creator/owner/admin rule is RLS-enforced) | Nothing is sent |
| `claimed` (running) | Sets **`cancel_requested_at`** and **`cancelled_by`** | The phone sees it over Realtime and **checks it before every send**; it stops, sets remaining `outbox` rows to a new **`CANCELLED`**, marks the unsent recipients `CANCELLED` in `message_history`, and finishes the job as `cancelled` with an honest count |
| `claimed`, phone offline or dead | `cancel_requested_at` stays set; UI reads *"Cancel requested — waiting for the phone"* | A resumed or relaunched phone **must not resume** a job with `cancel_requested_at`; if it never returns, the dispatcher sweep closes it as `cancelled` and the unsent recipients count as not sent |
| `done` / `cancelled` / `failed` / `expired` | not offered | — |

- **Precision:** at most **one** message can complete after the request, because the phone checks between sends. This is documented in the UI.
- **State machine:** `claimed → cancelled` was rejected by `send_jobs_guard()` (TEN-25). It becomes legal **only** when `cancel_requested_at` is set (or set by the phone itself). `cancel_requested_at`, `cancelled_by` are write-once.
- **Assistant:** `cancel_send_job` is an action in §22.4 (default Ask).
- **Paused — resume** (§18.5) never re-offers a cancel-requested job.
- **Reminder- and rule-generated jobs** (§16.7, §19) cancel through the same path.

### 23.5 How this changes §18

§18.4 step 5 becomes the **Schedule stop** above; §18.6 ("a `claimed` campaign cannot be cancelled from the browser") is superseded by §23.4; §18.3.2's status machine gains `cancel_requested_at`; and `outbox` / `message_history` gain a `CANCELLED` value.

### 23.6 Open decisions

| # | Decision | Options | Recommendation |
| :--- | :--- | :--- | :--- |
| **MSG-D1** | Stepper vs one long screen | 3 stops as asked / single scroll | **Decided 2026-09-19: 3 stops** — Schedule and Review are separate decisions. |
| **MSG-D2** | Autosave and conflicts | debounce + version CAS / last-write-wins / edit lock | **Decided 2026-09-19: an edit lock** (a leased lock, §23.1). The plain lock was chosen over version conflict diffs; the lease is what stops a dead phone holding it. |
| **MSG-D3** | Recipient-level status | add `CANCELLED` / reuse `SKIPPED` | **Decided 2026-09-19: add `CANCELLED`** — skipped means something different (§7.3). |
| **MSG-D4** | Dead-phone cancel timeout | dispatcher closes after *X* | **Decided 2026-09-19: 30 min**, then `cancelled`. |
| **MSG-D5** | Duplicate as draft | yes / no | **Decided 2026-09-19: yes**; copies body, audience filter and schedule, not results. |
| **MSG-D6** | Body search | `pg_trgm` GIN / plain `ilike` | **Decided 2026-09-19: `pg_trgm`** if the extension is available; `ilike` otherwise. |
| **MSG-D7** | Draft visibility | creator only / firm-shared / creator + owner | **Decided 2026-09-19: the creator, and the firm owner read-only.** Admins and other members cannot see a draft; only the creator can edit or submit it. |

### 23.7 Build order (proposed, after approval)

1. **Migration:** `message_drafts` + versions, `send_jobs.cancel_requested_at` / `cancelled_by`, the amended guard trigger, `cancel_send_job` RPC, `CANCELLED` values, search indexes.
2. **Composer** in `shared-ui`: Compose cards, **Schedule stop**, Review, leave-the-wizard sheet, Drafts.
3. **Batches list and detail** with search and filters.
4. **Phone cancel path** in `jobRunner.ts` (check before every send, no resume of cancel-requested jobs).
5. **Assistant integration** with the draft row (§22).

Test cases: `test-plan.md` §25.
