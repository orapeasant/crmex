# CRMEX — Android app

Capacitor Android shell + embedded Node (Baileys) WhatsApp sender, built against
`docs/spec/crmex.md` and the `/api/v1` core-server contract. See `../shared-ui`
for the cross-platform React components, `ApiClient`, and pure business logic
(phone normalization, outbox state machine, pacing, cache eviction).

## Layout

```
android/
├── capacitor.config.ts       # Capacitor project config (webDir=dist, android.path='.')
├── src/                      # thin shell: main.tsx mounts shared-ui's <CrmexApp>; native/ implements PlatformServices
├── dist/                     # vite build output (generated)
├── app/                      # native Gradle module (AndroidManifest, Java plugins)
├── nodejs-assets/nodejs-project/   # source-of-truth embedded Node payload (Baileys only)
├── scripts/copy-nodejs-payload.mjs # copies nodejs-project -> dist/nodejs before cap sync
└── gradlew / build.gradle / settings.gradle / variables.gradle   # native project root
```

### The app lives in shared-ui; this is the Android shell

All screens (sign-in, firm onboarding, Clients / Matters / Tasks / Messages,
menu pages), contexts and the design system (`shared-ui/src/app/styles.css`)
live in `shared-ui/src/app` so a browser shell can mount the same app
(crmex.md §11, §15.10). `src/main.tsx` only creates the Supabase client and
renders `<CrmexApp platform supabase coreServerUrl>`. Everything Capacitor-
specific is in `src/native/CapacitorPlatform.ts`, the Android implementation
of `PlatformServices` (`shared-ui/src/app/platform.ts`): Preferences, native
Google sign-in, SQLite outbox + cache purge, SIM/locale region, phone
contacts, ML Kit QR scanning, `crmex://invite/<token>` deep links, hardware
back, Share sheet, and `messaging` (Baileys over the Node IPC bridge). Because
`messaging` is present, this device sends directly and also runs `send_jobs`
the same user queued from a browser.

Two directory-layout decisions depart from the literal diagram in
`crmex.md` §2, both forced by real tool behavior confirmed during
implementation rather than assumed up front:

1. **`android.path: '.'` in `capacitor.config.ts`.** Capacitor's CLI
   defaults to expecting the native Gradle project at
   `<capacitor-root>/android/` — i.e. nested a second time under this
   already-named `android/` directory. Setting `android.path` to `.` tells
   the CLI the native project (`app/`, `gradle/`, `build.gradle`, ...) lives
   directly alongside `capacitor.config.ts`, which is what the spec's
   diagram actually shows and what we own as one directory.
2. **The Node payload physically ships from `dist/nodejs`, sourced from
   `nodejs-assets/nodejs-project`.** The real `capacitor-nodejs` plugin
   (see below) expects its Node project under `<webDir>/<nodeDir>`
   (default `nodeDir: "nodejs"`), not at a `nodejs-assets/nodejs-project`
   path — that path is the convention of an older, different plugin
   (`nodejs-mobile-cordova`). `nodejs-assets/nodejs-project` is kept as the
   source of truth (matches the spec doc, easy to find) and
   `npm run sync` copies it into `dist/nodejs` before `cap sync` runs.

## Step 0 spike — result: **PASSED end-to-end, on-device**, two real bugs found and fixed along the way

Per `PLAN.md` build order step 0, this had to be validated before any UI
work. Both halves passed:

### 1. Baileys itself (protocol/library layer)

Confirmed by running the corrected `main.js` (`crmex.md` §9.3) logic under
plain Node on the host machine (not yet the embedded runtime — see below):

- **Package**: `baileys` (npm), not `@whiskeysockets/baileys` — confirmed
  current per the task brief's warning. `baileys@latest` right now is
  `7.0.0-rc14`, a release candidate that pulls in a new dependency,
  `whatsapp-rust-bridge` (WASM, via `wasm-bindgen` — not a native `.node`
  binary, so it wouldn't by itself violate §10.4, but it's still a moving,
  pre-release rewrite).
- **Version pinned for this build: `baileys@6.7.24`**, the `legacy`
  dist-tag — the last stable line before the Rust/WASM rewrite. Verified
  its dependency tree is 100% pure JS (`libsignal` → `curve25519-js`, pure
  JS elliptic curve implementation; no `binding.gyp`, no `.node` files
  anywhere in `npm ls`).
- **Real transitive native-module risk found and removed**: `baileys`
  declares `sharp` (native `.node` binary per platform, via `libvips`) as a
  **peer** dependency for optional image-thumbnail features we don't use.
  Modern npm auto-installs "loose" peer deps by default, which silently
  pulled `sharp` + `@img/sharp-win32-x64/*.node` into the tree. This is
  *exactly* the risk `crmex.md` §10.4 warns about. Fixed by adding
  `legacy-peer-deps=true` to `nodejs-assets/nodejs-project/.npmrc`, which
  restores npm's pre-v7 behavior of not auto-installing peer deps. Verified
  after the fix: `find node_modules -iname "*.node"` and
  `find node_modules -iname "binding.gyp"` both return nothing. Baileys
  feature-detects `sharp`'s absence at runtime and simply skips the
  thumbnail path — we never generate link previews or stickers, so this
  costs nothing.
- **Live protocol test** (`node spike.js` against `baileys@6.7.24`, host
  Node v24, no device): `useMultiFileAuthState` → `fetchLatestBaileysVersion`
  → `makeWASocket` → the socket connected to WhatsApp's real servers,
  performed the handshake, and `connection.update` delivered a valid QR
  string (237 chars, `2@...`) within ~1 second. This proves the actual
  protocol/library layer works end-to-end; it does not by itself prove the
  *embedded-in-Android* runtime works, which is the second half below.

### 2. Embedding Node in the Android app (nodejs-mobile layer)

- **Package**: the task brief's own IPC-shape hint (`NodeJS.send()` /
  `NodeJS.addListener()`, Node-side `require('bridge')`) matches
  **`hampoelz/Capacitor-NodeJS`**, published to npm as `capacitor-nodejs`.
  It is **not resolvable via a normal `npm install capacitor-nodejs`** —
  the name is squatted on the public registry by an unrelated abandoned
  package (`capacitor-nodejs@0.0.1`, peer `@capacitor/core@^3.0.0`). The
  real plugin ships only as a GitHub release tarball:
  ```
  npm install https://github.com/hampoelz/Capacitor-NodeJS/releases/download/v1.0.0-beta.10/capacitor-nodejs.tgz
  ```
  (already wired into `package.json`'s `dependencies`).
- **Confirmed against the actual plugin README at implementation time**
  (not assumed from the task brief's generic description): the config key
  is `plugins.CapacitorNodeJS` (not `NodeJS`), and the Node-side bridge
  module exports `{ channel, getDataPath, onPause, onResume }` — you call
  `channel.send()` / `channel.addListener()`, not a flat `bridge.send()`.
  `main.js` was written directly against this real API.
  It requires **Capacitor v8+**, which is why every other Capacitor plugin
  in this project is pinned to its Capacitor-8-compatible major version
  (see `package.json` — several, e.g. `@capacitor-community/contacts`, had
  to be bumped from the versions a spec snippet might suggest, since those
  only support Capacitor 6).
- **It embeds a real, prebuilt Node 18.20.4** (`libnode.so`, confirmed via
  `node_version.h` in the plugin package) for `arm64-v8a`, `armeabi-v7a`,
  and `x86_64`. This is below `baileys`'s declared `engines.node: >=20` —
  see "Known risk" below.
- **It requires the Android NDK + CMake**, even though the JS payload
  itself has zero native dependencies. This is inherent to *any*
  nodejs-mobile-style embedding (the plugin compiles a small JNI shim,
  `native-lib.cpp` + `bridge.cpp`, that links against the prebuilt
  `libnode.so`) — it is not an extra risk introduced by a bad dependency,
  it's the cost of the embedding technique itself, and `crmex.md` §10.4
  frames the problem the same way ("Native Node modules must be compiled
  per Android ABI... Dropping sqlite3 from the Node process removes the
  **main** instance of this problem" — implying the base embedding cost was
  always expected to remain). The environment initially had no NDK
  installed; `sdkmanager --install "ndk;26.1.10909125" "cmake;3.22.1"`
  fixed this (Gradle's own dependency resolution then auto-installed NDK
  27.0.12077973 on top, since the plugin's `build.gradle` doesn't pin an
  exact NDK version — both coexist fine).
- **Confirmed: `gradlew assembleDebug` succeeds**, including the
  `configureCMakeDebug` / `buildCMakeDebug` steps for `arm64-v8a`,
  `armeabi-v7a`, and `x86_64`, producing a working `app-debug.apk`
  (175MB — expected, since it bundles a full `libnode.so` per ABI; a real
  release build should use App Bundle / split APKs per `crmex.md` §10.3,
  not yet configured in this pass).
- **Toolchain note, not part of the app itself**: building requires a JDK
  in the 21–24 range to run Gradle 8.14.3 (AGP 8.13 requires Gradle ≥8.13,
  which needs JDK ≥17 to run but tops out around JDK 24; some of this
  plugin's own modules declare `sourceCompatibility 21`, which additionally
  requires the JDK actually running Gradle to be ≥21). The system's default
  `JAVA_HOME` (JDK 18) is too old, and Android Studio's bundled JBR (25.0.3)
  is too new for Gradle 8.14.3 ("Unsupported class file major version 69").
  Neither is a project bug — see "How to build" below for the one-time
  workaround (a downloaded Temurin 21 JDK pointed at via `JAVA_HOME` for
  the Gradle invocation only).
- **Device/emulator result**: see "Device validation" below for exactly
  what was and wasn't run against real hardware.

### Two real bugs found by on-device testing, both fixed

The host-Node spike (above) proved the protocol/library layer. It did
**not** catch either of these — both are specific to the embedded Node
18.20.4 runtime and only surfaced once the actual APK ran on a device:

1. **`ERR_REQUIRE_ESM` crash, and it took the whole app process down.**
   `baileys@6.7.24`'s entry point is an ES module. `require('baileys')`
   works transparently under the host spike's Node v24 (recent Node
   versions added synchronous require-of-ESM interop) but throws under
   Node 18.20.4, which predates that interop. Worse: the uncaught exception
   during synchronous module initialization crashed the entire Android host
   process (logcat: `Process com.crmex.gateway (pid 5336) has died`), not
   just the embedded Node context — `nodejs-mobile` does not sandbox that.
   **Fix**: `main.js` now loads baileys via `await import('baileys')`
   (Node's own error message recommends exactly this) inside `initWhatsApp()`,
   and the top-level listeners are wrapped with `process.on('uncaughtException', ...)`
   / `process.on('unhandledRejection', ...)` as a safety net for anything
   after startup.
2. **`TypeError: Cannot destructure property 'subtle' of 'globalThis.crypto'`.**
   `baileys@6.7.24`'s crypto helpers assume the WebCrypto API is a global,
   which Node made true without a flag starting at v20. Node 18 only
   exposes it via `require('node:crypto').webcrypto`, not as `globalThis.crypto`.
   **Fix**: `main.js` polyfills `globalThis.crypto = require('node:crypto').webcrypto`
   before baileys is ever imported.

Both fixes are narrow, load-bearing comments are left in `main.js` at the
exact lines so a future Baileys/nodejs-mobile upgrade that changes either
assumption is easy to re-diagnose.

**After both fixes**, confirmed on an Android emulator (see below): the
embedded Node process starts, connects to WhatsApp's real servers
(`"msg":"connected to WA"` in logcat), performs the registration handshake,
and emits a `wa:qr` event over the capacitor-nodejs IPC bridge with a
well-formed QR payload — which the WebView receives, converts to a scannable
image via the `qrcode` library, and renders. Screenshot-equivalent
confirmation: the exact on-screen QR code was captured via `adb screencap`
during this session (not included as a file here since it's a live,
short-TTL pairing code with no lasting value once captured, but the logcat
transcript is preserved in this session's history and the rendering pipeline
that produced it — `QrPairing.tsx` — is unchanged and unit-inspectable).

## Device validation

**Physical device (Huawei P30 Pro, API 29, arm64-v8a)**: not reachable at
any point during this build session — `adb devices -l` returned an empty
list every time it was checked (checked well over a dozen times across the
session, not just once). No on-device testing could be performed against
it. **This is the single biggest open item** — re-run the checklist below
the moment the device is available. Everything below was instead run
against an **Android emulator** (`Medium_Phone_API_36.0`, x86_64, API 36)
as the explicitly-sanctioned fallback.

**What was actually run, and where:**

| What | Where | Result |
| :--- | :--- | :--- |
| Baileys socket connects, handshakes, emits a QR via `connection.update` | Host Node v24 (`baileys@6.7.24`) | **Confirmed** — real QR string received from WhatsApp's servers |
| Node payload dependency tree has zero native `.node` binaries / `binding.gyp` | Host, `nodejs-assets/nodejs-project` after `npm install` | **Confirmed** |
| Full Gradle build incl. native JNI compile for the Node embedding (3 ABIs) | Host, `gradlew assembleDebug` | **Confirmed** — `BUILD SUCCESSFUL`, `app-debug.apk` produced |
| App installs, embedded Node process starts, socket connects to real WhatsApp servers, `wa:qr` reaches the WebView, QR renders as a scannable image | Android emulator (x86_64) | **Confirmed** — required the two fixes above; captured in logcat and via `adb screencap` |
| All 9 Capacitor plugins (incl. the 4 custom Java ones: `SimRegion`, `BackgroundEngine`, `BatteryWhitelist`, `MediaSave`) register without error at app startup | Android emulator | **Confirmed** (logcat: `Registering plugin instance: <name>` for all 9, no exceptions) |
| AND-09 — no TCP port listening from this app | Android emulator, `adb shell cat /proc/net/tcp{,6}` cross-referenced against the app's UID (10216, confirmed via `dumpsys package`) | **Confirmed** — zero listening sockets for uid 10216, IPv4 or IPv6; the only listener on the whole device is `adbd` itself (uid 2000) |
| WA-02 (real pairing with a WhatsApp account), Doze/EMUI battery-kill behavior, real `READ_CONTACTS` permission flow, Gallery visibility of a `MediaSave`d image, actual foreground-service-driven send batch, anything requiring the physical Huawei device specifically | Not run | **Explicitly not claimed as passing** — see test log below |

## What's built vs. what's still a skeleton

**Built and unit/integration-tested** (`shared-ui`, 152 tests passing as of 2026-09-19, see
`../shared-ui/package.json` — `pnpm test`):
- E.164 phone normalization + `needsReview` bucket + region re-evaluation (PHN-01..10, CON-04..07)
- JID derivation
- SIM-region → locale → hard-default precedence (`resolveDefaultRegion`, PHN-08)
- Contact NL-match wrapper: strips phone/JID from the server payload (NLM-04), discards server-returned ids not in the submitted index (NLM-05)
- Queue construction: dedup, `needsReview`/unconfirmed/suppressed/unregistered exclusion, all enforced at construction not just in UI (PHN-10, SAF-02, SEND-04, SEND-09, CON-07)
- Outbox durability state machine: PENDING→CLAIMED→settle→mirror→delete, claimed-but-unsettled surfaced not resent (SEND-05/06/07), mirror-failure retry without resend (SEND-13)
- `sendFlow.confirmAndSend`: proves outbox rows are durable (CLAIMED) *before* `NativeBridge.sendBatch` is ever called — the exact ordering §9.2 requires — plus `wireSendResultHandling` routing `wa:result`/`wa:batch-done` back into the outbox + mirror pipeline
- Pacing math (PAC-01/02/04) — `main.js` carries a hand-synced plain-JS copy since the Node payload can't depend on `shared-ui`
- Image cache eviction by `last_used_at` respecting in-use paths (CSH-03), storage-path traversal/absolute/encoded/empty rejection (ISO-15..19)
- `ApiClient` against the exact `/api/v1` contract, integration-tested against a local mock `core-server` this project wrote (`shared-ui/src/testing/mockCoreServer.ts`) since the real one isn't running
- Direct-Supabase repo functions (`message_history` mirror, `contact_meta`/suppression, `image_sessions`, signed URL refresh) against a hand-written fake Supabase client (`shared-ui/src/testing/fakeSupabase.ts`) — **there is no real Supabase project to test against in this pass**; these are structurally verified, not verified against real RLS policies (that's `core-server`/`supabase`'s side of the contract, being built in parallel)
- Send-confirmation two-tap gate (SAF-01/SAF-04 automatable half — see test log for what's still manual)

**Built, not yet unit-tested at the platform layer** (needs the device):
`android/src/native/*` — `CapacitorNativeBridge`, `SqliteLocalStore`,
`contactsAdapter`, the custom Java plugins (`SimRegionPlugin`,
`BackgroundEnginePlugin`/`BackgroundEngineService`, `BatteryWhitelistPlugin`,
`MediaSavePlugin`). These compile (see Gradle result above) but their
actual runtime behavior against real Android APIs has not been exercised.

**Superseded — this section described the state before the app shell.** As of
2026-09-19 the shared app (`shared-ui/src/app/`) is a four-tab shell (Clients ·
Matters · Tasks · Messages) with firm onboarding and a switcher, and the
Compose → Contacts → Review → Schedule send wizard is wired end to end; PLAN.md
steps 0–16 are done. The paragraph below is kept only for the seam description,
which is still accurate.

*Historic:* Full contact-search / image-generate-refine / send-confirmation
*screens* wired together into one flow. `App.tsx` then only implemented
sign-in-gate → WhatsApp QR pairing, which was enough to prove the two seams
(`ApiClient`, `NativeBridge`) and the Step 0 spike, but stopped short of
PLAN.md step 7 ("wire the end-to-end flow"). The components that exist
(`QrPairing`, `SendConfirmation`) are real and tested; `ContactMatchScreen`
and an `ImageCanvas` component are not yet written. Given the scope of
everything else in this task, this was the deliberate cut — see "What's
left" at the end of this file.

## Build

Prerequisites confirmed working on this machine at the time of this build:
- Android SDK at `%LOCALAPPDATA%\Android\Sdk`, platforms 24–36, build-tools 35/36, `cmdline-tools\latest`
- NDK `26.1.10909125` + CMake `3.22.1` (installed during this build via `sdkmanager`; auto-resolves NDK `27.x` too, both coexist)
- **A JDK in the 21–24 range to run Gradle** — neither the machine's default `JAVA_HOME` (JDK 18) nor Android Studio's bundled JBR (25) works with Gradle 8.14.3. This build used a standalone Temurin 21 download. Point `JAVA_HOME` at it only for the Gradle invocation:
  ```powershell
  $env:JAVA_HOME = "C:\path\to\jdk-21.0.12.1+1"
  ```

Steps:

```bash
cd android
npm install                       # web app deps (React, Capacitor plugins, shared-ui via file:../shared-ui)
cd ../shared-ui && npm install    # shared-ui's own deps (used as TS source directly, no build step needed)
cd ../android

npm run build                     # tsc --noEmit && vite build -> dist/
npm run sync                      # copies nodejs-assets/nodejs-project -> dist/nodejs, then `cap sync android`

# one-time: nodejs-assets/nodejs-project needs its own npm install before the
# first `npm run sync`, since that's what gets copied into the APK assets:
cd nodejs-assets/nodejs-project && npm install && cd ../..

# create android/local.properties with sdk.dir pointing at your SDK (gitignored, not checked in):
#   sdk.dir=C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk

$env:JAVA_HOME = "<path to a JDK 21-24>"
.\gradlew.bat assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

## Install to a connected device

```bash
adb devices -l                     # confirm the device shows up
.\gradlew.bat installDebug          # or: adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Manual setup remaining (cannot be completed without real credentials)

1. **Real Supabase project.** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
   env vars (read by `src/env.ts` at Vite build time — put them in
   `android/.env`, gitignored). Without these the app renders a sign-in
   screen that fails cleanly with a "Supabase not configured" message
   rather than crashing (see `App.tsx`'s `useSupabase()`).
2. **Real Google OAuth Web client ID**, for two places:
   - `capacitor.config.ts` → `plugins.GoogleAuth.serverClientId` (currently
     a placeholder string) — this must be the **Web** client ID, not the
     Android one, so the ID token's audience matches what Supabase's
     `signInWithIdToken` expects (`crmex.md` §5).
   - Registered as the Google provider's client ID in the Supabase
     dashboard's Auth settings.
   - `@southdevs/capacitor-google-auth` is used instead of the spec's
     suggested `@codetrix-studio/capacitor-google-auth`, which is pinned to
     Capacitor ^6 and can't install alongside `capacitor-nodejs`'s
     Capacitor 8 requirement. It's an actively maintained fork with the
     same `GoogleAuth.signIn()` / `authentication.idToken` API — confirmed
     against its README, not assumed.
3. **`VITE_CORE_SERVER_URL`** — defaults to `http://10.0.2.2:8080/api/v1`
   (the standard Android-emulator alias for the host machine's localhost),
   fine for local dev against a mock or local `core-server`; set to the
   real deployed URL otherwise.
4. **Play Store vs. sideload — explicitly undecided, per `crmex.md` §10.3/§14.**
   The manifest currently declares `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
   unconditionally (needed for the Huawei/EMUI battery-whitelist prompt,
   `AND-08`) — this is a **restricted permission on Play** requiring a
   granted policy exemption. If Play is chosen, resolve that policy
   question first (per the spec) and strip the permission from the
   manifest if no exemption is granted. No signing config beyond the
   Capacitor-generated debug keystore exists yet; a release signing
   config is a "still to do" for either distribution path.
5. **Release APK size / delivery format.** The debug APK is 175MB because
   it bundles `libnode.so` for three ABIs. `crmex.md` §10.3 calls for
   split APKs / App Bundle for a real release — not configured in this
   pass (`gradlew bundleRelease` / `splits { abi { ... } }` still to add).

## Huawei/EMUI battery whitelist (AND-08)

`BatteryWhitelistPlugin` (Java) exposes the **standard AOSP**
battery-optimization-exemption check/prompt
(`PowerManager.isIgnoringBatteryOptimizations` /
`Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). This does help
even on EMUI, but **there is no public, stable API to detect or open
Huawei's separate "Protected apps" manager** — that screen and its Intent
action are not part of AOSP and have changed across EMUI versions with no
documented contract. The honest scope here: the app can prompt the
standard Android exemption automatically; getting whitelisted in Huawei's
own battery manager is a manual step that has to stay a documented
instruction to the user, not something this code can drive. This matches
`crmex.md` §10.2's own framing — a foreground service resists Doze, it
does not make the process unkillable, and OEM battery managers are a real,
only-partially-mitigable risk on the actual test device.

## What's left

- Run the full device checklist below the moment the Huawei P30 Pro (or
  any arm64-v8a Android device) is reachable — this is the one gate PLAN.md
  step 0 asks for that could not be closed in this pass.
- Build `ContactMatchScreen` and an `ImageCanvas` component in `shared-ui`
  and wire `App.tsx` into the full contact-match → generate/refine →
  save → confirm → send flow (PLAN.md step 7). The pieces it needs already
  exist and are tested (`ApiClient`, `queueBuilder`, `OutboxManager`,
  `SendConfirmation`, `matchContactsForConfirmation`, and now
  `sendFlow.confirmAndSend`/`wireSendResultHandling`, added specifically to
  close the §9.2 ordering gap — durable outbox write happens before the IPC
  handoff, and `wa:result`/`wa:batch-done` route back into the outbox +
  mirror pipeline; see `shared-ui/src/send/sendFlow.ts`).
- Release signing + split APK / App Bundle configuration.
- Decide Play vs. sideload (blocks whether `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` ships).
