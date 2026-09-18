// android/nodejs-assets/nodejs-project/main.js
//
// Baileys WhatsApp socket + send-pacing loop. Nothing else lives here
// (crmex.md §9.1, §9.3, §10.4): no database, no HTTP server, no dependency
// beyond `baileys`. All durability lives in the WebView's SQLite `outbox`
// (crmex.md §9.2) — this process only ever sees an in-memory batch handed
// to it over the capacitor-nodejs IPC bridge and reports results back the
// same way.
'use strict';

// baileys@6.7.24's crypto helpers destructure `globalThis.crypto.subtle`
// (the WebCrypto API) unconditionally. Node made `crypto` a global without a
// flag starting in v20; the embedded runtime here is v18.20.4 (see below),
// which only exposes WebCrypto via `require('node:crypto').webcrypto`, not
// as a global. Confirmed on-device: without this polyfill, loading baileys
// throws `TypeError: Cannot destructure property 'subtle' of
// 'globalThis.crypto' as it is undefined` at
// node_modules/baileys/lib/Utils/crypto.js:6. Must run before baileys is
// imported.
if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

// baileys@6.7.24 ships as an ES module (`lib/index.js`). Under the HOST
// Node used for the Step 0 protocol spike (v24), `require('baileys')` works
// transparently because recent Node versions added synchronous require()-of-ESM
// interop. The EMBEDDED runtime here is Node 18.20.4 (bundled by
// capacitor-nodejs — see android/README.md), which predates that interop
// entirely: a plain `require('baileys')` throws ERR_REQUIRE_ESM and — worse —
// took the whole host Android process down with it the first time this was
// tested on-device (uncaught exception during synchronous module
// initialization, not just a rejected promise). Dynamic `import()` is the
// fix Node's own error message recommends, and it works identically on 18.
let makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason;
const fs = require('node:fs');
const { randomInterval } = require('./pacing');

// `bridge` is injected by capacitor-nodejs at runtime (require('bridge') —
// see android/README.md for the exact API surface, confirmed against the
// hampoelz/Capacitor-NodeJS README at implementation time: the module
// exports { channel, getDataPath, onPause, onResume }, not a flat
// send()/on() pair). It is not an npm dependency of this payload.
const { channel, getDataPath } = require('bridge');

const MIN_INTERVAL_MS = Number(process.env.WA_PACING_MIN_MS || 7000);
const MAX_INTERVAL_MS = Number(process.env.WA_PACING_MAX_MS || 18000);
const MAX_BACKOFF_MS = 30000;

let sock = null;
let ready = false;
let reconnectAttempts = 0;
let readyWaiters = [];
// Bumped whenever a socket is deliberately replaced (relink), so events and
// reconnect timers from the old socket are ignored instead of reviving it.
let socketGeneration = 0;
// Last known state, so a screen opened after an event fired can still show it.
let connState = 'connecting'; // 'connecting' | 'qr' | 'ready' | 'logged-out'
let lastQr = null;

function authDirPath() {
  return typeof getDataPath === 'function' ? `${getDataPath()}/wa-auth` : './wa-auth';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForReady() {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => readyWaiters.push(resolve));
}

function resolveReadyWaiters() {
  const waiters = readyWaiters;
  readyWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function reportFatal(err) {
  // eslint-disable-next-line no-console
  console.error('[crmex fatal]', err && err.stack ? err.stack : err);
  channel.send('wa:fatal', { message: String(err && err.stack ? err.stack : err) });
}

async function loadBaileys() {
  const mod = await import('baileys');
  makeWASocket = mod.default;
  useMultiFileAuthState = mod.useMultiFileAuthState;
  fetchLatestBaileysVersion = mod.fetchLatestBaileysVersion;
  DisconnectReason = mod.DisconnectReason;
}

async function initWhatsApp() {
  if (!makeWASocket) await loadBaileys();
  const generation = socketGeneration;
  const { state, saveCreds } = await useMultiFileAuthState(authDirPath());
  const { version } = await fetchLatestBaileysVersion();
  if (generation !== socketGeneration) return; // a relink started while we were loading

  sock = makeWASocket({ version, auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (generation !== socketGeneration) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connState = 'qr';
      lastQr = qr;
      channel.send('wa:qr', { qr });
    }

    if (connection === 'open') {
      ready = true;
      connState = 'ready';
      lastQr = null;
      reconnectAttempts = 0; // WA-07: attempt counter resets on a successful reconnect
      channel.send('wa:ready', {});
      resolveReadyWaiters();
    }

    if (connection === 'close') {
      ready = false;
      const status = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;

      if (status === DisconnectReason.loggedOut) {
        // WA-06: does NOT enter a reconnect loop — needs a fresh QR pairing,
        // which the user starts explicitly with wa:relink.
        connState = 'logged-out';
        lastQr = null;
        channel.send('wa:logged-out', {});
        return;
      }

      // WA-04/WA-05: every other close is transient — reconnect with capped
      // exponential backoff, never a tight retry loop.
      connState = 'connecting';
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, reconnectAttempts++));
      channel.send('wa:reconnecting', { delayMs: delay, attempt: reconnectAttempts });
      setTimeout(() => {
        if (generation !== socketGeneration) return;
        initWhatsApp().catch(reportFatal);
      }, delay);
    }
  });
}

/**
 * Drops the current WhatsApp session (logging this device out of the linked
 * account if it is still linked), deletes the stored credentials and starts a
 * fresh socket, which emits a new pairing QR.
 */
async function relinkWhatsApp() {
  socketGeneration++;
  const old = sock;
  sock = null;
  ready = false;
  connState = 'connecting';
  lastQr = null;
  channel.send('wa:reconnecting', { delayMs: 0, attempt: 0 });
  if (old) {
    try {
      await old.logout();
    } catch (err) {
      // Already logged out or offline — the credentials are deleted below either way.
    }
    try {
      old.end(undefined);
    } catch (err) {
      /* socket already closed */
    }
  }
  fs.rmSync(authDirPath(), { recursive: true, force: true });
  reconnectAttempts = 0;
  await initWhatsApp();
}

/**
 * SEND-04: registration check runs before queueing, but the WebView is the
 * one deciding what to queue — this just answers the question over IPC so
 * the WebView's queueBuilder (shared-ui) can apply it (crmex.md §7.3).
 */
async function checkRegistered(jids) {
  const results = {};
  for (const jid of jids) {
    try {
      if (!ready) await waitForReady();
      const res = await sock.onWhatsApp(jid);
      results[jid] = Array.isArray(res) && res.length > 0 && res[0].exists === true;
    } catch (err) {
      results[jid] = false;
    }
  }
  return results;
}

async function runBatch(batch) {
  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];

    if (!ready) {
      channel.send('wa:waiting-for-connection', { batchId: batch.batchId });
      await waitForReady(); // SEND-10: wait, don't mark the remainder failed
    }

    try {
      const content = item.mediaBytesBase64
        ? { image: Buffer.from(item.mediaBytesBase64, 'base64'), caption: item.body }
        : { text: item.body };
      await sock.sendMessage(item.jid, content);
      channel.send('wa:result', { id: item.id, status: 'SENT' });
    } catch (err) {
      channel.send('wa:result', { id: item.id, status: 'FAILED', error: String(err) });
    }

    // Sends are strictly sequential (PAC-03): the next iteration of this
    // for-loop does not start until the previous send has resolved and the
    // paced sleep below has elapsed. No Promise.all, no concurrent sends.
    if (i < batch.items.length - 1) {
      await sleep(randomInterval(MIN_INTERVAL_MS, MAX_INTERVAL_MS));
    }
  }
  channel.send('wa:batch-done', { batchId: batch.batchId });
}

channel.addListener('wa:send-batch', (batch) => {
  runBatch(batch).catch(reportFatal);
});

channel.addListener('wa:get-state', () => {
  channel.send('wa:state', { state: connState, qr: lastQr });
});

let relinking = false;
channel.addListener('wa:relink', () => {
  if (relinking) return;
  relinking = true;
  relinkWhatsApp()
    .catch(reportFatal)
    .finally(() => {
      relinking = false;
    });
});

channel.addListener('wa:check-registered', async (payload) => {
  try {
    const results = await checkRegistered(payload.jids);
    channel.send('wa:registered-result', { requestId: payload.requestId, results });
  } catch (err) {
    channel.send('wa:registered-result', { requestId: payload.requestId, error: String(err) });
  }
});

// Safety net proven necessary by real on-device testing: an uncaught
// exception during synchronous module init (the ERR_REQUIRE_ESM crash this
// fix replaces) took down the entire host Android process, not just this
// Node context — nodejs-mobile does not sandbox that. Catching here can't
// undo a crash that already happened synchronously before this file
// finished loading, but it prevents anything *after* startup from doing the
// same thing silently.
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', (reason) => reportFatal(reason instanceof Error ? reason : new Error(String(reason))));

initWhatsApp().catch(reportFatal);
