# web-ui — Leagentex in the browser

The desktop web portal (crmex.md §11, §15.10): Vite + React 19 + Tailwind CSS v4 +
shadcn/ui (components copied into `src/components/ui`), react-router URL routing and
TanStack Query/Table. Screens live in `src/portal`; all non-visual logic (session,
firm state, org-scoped repositories, send_jobs queueing, invite parsing) comes from
`shared-ui` through its headless exports (`useCrmexSession`, `CrmexProviders`,
`crmRepo`, `data.ts` loaders). The Android app keeps its own phone UI.
The browser implementation of `PlatformServices` is `src/browserPlatform.ts`. The browser never holds a WhatsApp session: sending
queues a `send_job` that the user's own phone runs, and WhatsApp linking,
phone-contacts import and QR scanning are hidden.

## Run

```sh
cd web-ui
npm install
cp .env.example .env   # then fill in the values (see below)
npm run dev            # http://localhost:5173 (fixed port)
```

Scripts: `dev`, `build` (`tsc --noEmit && vite build`), `preview`, `typecheck`.

`core-server` must be running (default `VITE_CORE_SERVER_URL=http://localhost:8080/api/v1`)
and its `CORS_ALLOWED_ORIGINS` must include `http://localhost:5173`.

### Environment (`web-ui/.env`, gitignored)

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_ANON_KEY` | The **anon / publishable** key. Everything `VITE_*` is inlined into the public bundle. |
| `VITE_CORE_SERVER_URL` | `http://localhost:8080/api/v1` |

A `service_role` (or `sb_secret_…`) key is refused twice: `vite` fails to start/build,
and the app shows an "Unsafe configuration" screen without creating a Supabase client.
If one was ever put here and shared, rotate it.

## One-time Supabase setup

Browser sign-in uses the OAuth redirect flow (PKCE), unlike Android's native ID-token flow.

1. **Supabase Dashboard → Authentication → URL Configuration → Redirect URLs:** add
   `http://localhost:5173` (add `http://localhost:5173/**` too if you want deep paths to be allowed).
2. **Authentication → Sign In / Providers → Google:** enable it and set the **Web application**
   OAuth client's **Client ID and Client Secret** (the redirect flow needs the secret).
   If Android's ID-token sign-in also uses this provider, keep the Android/Web client IDs it needs
   in the authorized client IDs list.
3. **Google Cloud Console → that Web OAuth client → Authorized redirect URIs:** must contain
   `https://<project-ref>.supabase.co/auth/v1/callback`.

## Dev preview harness (no sign-in needed)

`npm run dev`, then open `http://localhost:5173/clients?preview=1` (`?preview=0` turns it off;
`&role=member` previews a non-admin). It renders the real portal against an in-memory fake
Supabase and fake core-server (`src/dev/preview.tsx`). It exists only in dev: the branch is behind
`import.meta.env.DEV` and is removed from `npm run build` output.

## Routes

`/clients`, `/clients/:id?tab=matters|tasks|messages|notes`, `/matters`, `/matters/:id?tab=people|tasks|messages|notes`,
`/tasks`, `/messages`, `/messages/new` (`?to=<clientIds>`, `?step=1|2`), `/messages/batches/:id`,
`/settings/firm`, `/settings/account`, `/settings/billing`, `/settings/usage`, `/invite/:token`.
List filters are kept in the query string, so refresh and shared links keep them.

## Browser specifics

- Preferences live in `localStorage` under `crmex:`; sign-out removes the user's keys.
- Invitation links `http://localhost:5173/invite/<token>` are captured on load and the URL is
  replaced with `/`. If the user isn't signed in, the token is kept in `sessionStorage` across the
  Google redirect and offered after sign-in.
- Browser Back/Forward are real URL navigation (the phone UI's back-handler bridge is off here).
- Each user+firm gets its own TanStack QueryClient; switching firms discards the previous firm's cache.
- Layout targets 1280px+ and degrades to ~768px; below 900px the sidebar becomes an off-canvas sheet.
- Account menu (avatar) is at the bottom of the sidebar; its Light/Dark/System theme picker is a row of icons (stored per browser).
- An unsent message draft (text + selected client ids, never the image preview URL) survives a refresh in the same tab; it is cleared when queued and on sign-out.
