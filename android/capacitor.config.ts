import type { CapacitorConfig } from '@capacitor/cli';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Local development points the app at an http:// core-server (via adb
// reverse). The WebView page is served from https://localhost, so reaching it
// needs mixed content and cleartext traffic allowed. Both are switched on only
// when .env's VITE_CORE_SERVER_URL is http://, so a build pointed at an https
// server keeps Android's defaults. `npx cap sync` must be re-run after
// changing the URL, since this file is evaluated at sync time.
function coreServerUsesHttp(): boolean {
  // The Capacitor CLI transpiles this file to CommonJS, where import.meta is unavailable; cap commands run from android/.
  const envFile = join(process.cwd(), '.env');
  if (!existsSync(envFile)) return false;
  const match = readFileSync(envFile, 'utf8').match(/^\s*VITE_CORE_SERVER_URL\s*=\s*(\S+)/m);
  return match ? match[1].startsWith('http://') : false;
}
const allowHttpCoreServer = coreServerUsesHttp();

// Config keys confirmed against the hampoelz/Capacitor-NodeJS README at
// implementation time (v1.0.0-beta.10) rather than assumed — the plugin key
// is `CapacitorNodeJS` (not `NodeJS`), and `nodeDir` is resolved relative to
// `webDir`. The source-of-truth Node payload lives at
// nodejs-assets/nodejs-project (matching crmex.md's documented repo layout);
// `npm run sync` copies it into `dist/nodejs` before `cap sync` because that
// is where this specific plugin actually expects to find it — see
// android/README.md "Step 0 spike" / "Build" sections for why these two
// paths differ.
const config: CapacitorConfig = {
  appId: 'com.crmex.gateway',
  appName: 'Leagentex',
  webDir: 'dist',
  // Capacitor's CLI defaults to looking for the native project at
  // `<capacitor-root>/android/`, i.e. nested a second time under this
  // already-named `android/` directory. `android.path: '.'` tells it the
  // native Gradle project (app/, gradle/, build.gradle, ...) lives directly
  // alongside this config file instead — which is what crmex.md's repo
  // layout diagram shows and what we actually own as one directory.
  android: {
    path: '.',
    allowMixedContent: allowHttpCoreServer,
  },
  server: {
    cleartext: allowHttpCoreServer,
  },
  plugins: {
    CapacitorNodeJS: {
      nodeDir: 'nodejs',
      startMode: 'auto',
    },
    GoogleAuth: {
      // This MUST be the OAuth 2.0 *Web* client ID (not the Android one),
      // because it is passed to requestIdToken() as the audience the
      // resulting ID token is minted for — which is what Supabase's
      // signInWithIdToken verifies against (crmex.md §5). The Android
      // OAuth client still has to exist in the same Google Cloud project
      // (package com.crmex.gateway + the signing cert's SHA-1), but its
      // client ID is never named here.
      //
      // The key MUST be `clientId`, not `serverClientId`. This plugin's
      // Android implementation resolves it as
      //   androidClientId -> clientId -> R.string.server_client_id
      // (GoogleAuth.java:184-186) and never reads `serverClientId` at all;
      // its web implementation reads `clientId` too. Using the wrong key
      // silently falls through to the library's placeholder string
      // resource ("Your Web Client Key") and fails at runtime with
      // GoogleSignIn DEVELOPER_ERROR (code 10) — an error that looks like
      // a Cloud Console misconfiguration and sends you hunting in the
      // wrong place. See also the res/values/strings.xml override.
      clientId: '620521815022-hujedvo32ttsd4g1qtvnd9sfo9v7bh6f.apps.googleusercontent.com',
      scopes: ['profile', 'email'],
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;
