# CRMEX — Test Plan

Test cases derived from `crmex.md`. Each scenario appears exactly once; where an area depends on behaviour proven elsewhere, it cross-references the case ID rather than restating it.

## Conventions

**Levels** — what a case needs to run:

| Level | Meaning |
| :--- | :--- |
| **U** | Unit. Pure logic, no I/O. Fast, run on every commit. |
| **I** | Integration. Real Supabase test project; AI providers stubbed. |
| **D** | Device. Requires a physical Android device. |
| **M** | Manual. Cannot reasonably be automated; run against a release candidate. |

**Fixtures** — the same two accounts are used throughout, because most security cases are two-party by nature:

- **User A**, **User B** — two distinct Supabase accounts. Never collapse these into one; a single-account test suite cannot detect an isolation failure.
- **Admin** — an account with `app_metadata.role = 'admin'`.
- **Contacts fixture** — an address book containing: a valid international number, a valid local number, an unparseable string, a contact with three numbers, a contact with no numbers, a duplicate number under two names, and a number not registered on WhatsApp.
- **WhatsApp recipients** — a second controlled WhatsApp account. See "Constraints" below.

**Constraints worth planning around:**

- **Send tests cannot use real third parties.** Every message that leaves the device goes to a real person. Use a small set of controlled recipient accounts, and never load-test delivery — high-volume automated sending is exactly the behaviour that gets a number banned, so the pacing and volume paths are verified by asserting on timing and queue state, not by actually sending hundreds of messages.
- **Baileys is an unofficial client.** Its integration tests are inherently brittle and will break on upstream protocol changes. Isolate them so an upstream break does not fail the whole suite.

---

## 1. Authentication

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| AUTH-01 | Native Google Sign-In returns an ID token, exchanged via `signInWithIdToken` | Valid Supabase session established | D |
| AUTH-02 | Request to a protected route with no `Authorization` header | 401, no side effects | I |
| AUTH-03 | Request with a malformed JWT | 401 | I |
| AUTH-04 | Request with an expired JWT | 401 | I |
| AUTH-05 | Request with a JWT signed by a different project | 401 | I |
| AUTH-06 | Session refresh while a batch is in flight | Batch continues; no dropped sends | D |
| AUTH-07 | Sign-out | Supabase session cleared, cache purged (→ ISO-13), in-memory contact/image state cleared | D |
| AUTH-08 | Relaunch after sign-in | Session restored without re-authenticating | D |

## 2. User isolation

The security core. Every case here is two-party: act as **B**, target **A**'s data.

### 2.1 Postgres

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| ISO-01 | B queries `message_history` directly with B's JWT | Only B's rows; A's invisible | I |
| ISO-02 | B queries `image_sessions` directly | Only B's rows | I |
| ISO-03 | B queries `contact_meta` directly | Only B's rows | I |
| ISO-04 | B attempts to `insert` a row with `user_id = A` | Rejected by the RLS `with check` clause | I |
| ISO-05 | B attempts to `update` one of A's rows by id | Zero rows affected | I |
| ISO-06 | B attempts to `delete` one of A's rows by id | Zero rows affected | I |

### 2.2 Storage

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| ISO-07 | Unauthenticated GET of a known object path | Denied — confirms the bucket is private, not public | I |
| ISO-08 | B requests a signed URL for an object under A's prefix | Denied; no URL issued | I |
| ISO-09 | B attempts a direct download of A's object with B's JWT | Denied by folder-prefix policy | I |
| ISO-10 | B attempts to upload into A's prefix | Denied | I |
| ISO-11 | A valid signed URL for A's own object | Fetches successfully, and fails after TTL expiry | I |

### 2.3 Server-side controls

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| ISO-12 | Request body carries `user_id = A` while authenticated as B | Body value ignored entirely; operation scoped to B | I |
| ISO-13 | Sign out A, sign in B on the same device | A's cache directory purged; B cannot read A's cached files by any path | D |
| ISO-14 | Local SQLite query while signed in as B | `outbox` and `image_cache` return only B's rows | D |

### 2.4 Path handling

Each of these supplies a hostile value where a storage path is derived.

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| ISO-15 | Client supplies `../<A>/secret.png` as an image reference | Rejected; no traversal outside the caller's prefix | U |
| ISO-16 | Client supplies an absolute path | Rejected | U |
| ISO-17 | Client supplies a path with a URL-encoded traversal (`%2e%2e%2f`) | Rejected after decoding | U |
| ISO-18 | Client supplies an empty or null reference | Rejected, no unprefixed path constructed | U |
| ISO-19 | Generated object path for a known user and content hash | Exactly `<user_id>/<sha256>.png`; no client input present | U |

### 2.5 Cross-user leakage through caching

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| ISO-20 | A and B submit the identical generation prompt | Two distinct objects under two prefixes; neither receives the other's | I |

## 3. Roles and admin access control

In scope now even though the portal is not being built (`crmex.md` §13), because these are server-side gates.

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| ROLE-01 | Normal user calls `/api/v1/admin/*` | 403 | I |
| ROLE-02 | User sets `user_metadata.role = 'admin'` on their own session, then calls an admin route | 403 — role is read from `app_metadata` only | I |
| ROLE-03 | Admin account calls an admin route | Permitted | I |
| ROLE-04 | Admin JWT used against a normal user route | Scoped to the admin's own `user_id`; admin role grants no cross-user read | I |
| ROLE-05 | Admin route reached without the admin middleware applied | Caught by a route-coverage test asserting every `/admin/*` route is wrapped | U |

## 4. Contacts

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| CON-01 | Permission granted | Address book read | D |
| CON-02 | Permission denied at the prompt | `CONTACTS_PERMISSION_DENIED` surfaced in the UI; no crash, no partial list | D |
| CON-03 | Permission previously denied, app relaunched | Re-prompt or settings deep link; no silent empty list | D |
| CON-04 | Contact with no phone numbers | Excluded from both buckets | U |
| CON-05 | Contact with three numbers | All three offered for selection | U |
| CON-06 | Contact with no display name | Falls back to "Unknown Contact" | U |
| CON-07 | Same number under two contacts | Surfaced once per contact; sending selects one — no duplicate send to one number (→ SEND-09) | U |
| CON-08 | Empty address book | Empty-state UI, no error | D |
| CON-09 | Large address book (5,000+ contacts) | Renders without freezing; virtualized list | D |

## 5. Phone normalization

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| PHN-01 | Number already in international form (`+20 100 123 4567`) | Correct E.164, region-independent | U |
| PHN-02 | Local number with matching SIM region (`0100 123 4567`, EG) | `+201001234567` | U |
| PHN-03 | Same local number with a different region set | Different E.164 — proves the region is actually applied | U |
| PHN-04 | Number with spaces, dashes, parentheses | Normalized correctly | U |
| PHN-05 | Unparseable string (`"call me"`, `"12"`) | Lands in `needsReview`, never in `usable` | U |
| PHN-06 | Valid-looking but invalid number for the region | `needsReview`, not a silently wrong E.164 | U |
| PHN-07 | JID derivation from E.164 | `201001234567@s.whatsapp.net` — leading `+` stripped, no double-strip | U |
| PHN-08 | SIM region unavailable | Falls back to locale region; user override still applied | D |
| PHN-09 | User changes region override | Previously `needsReview` numbers re-evaluate | U |
| PHN-10 | Nothing in `needsReview` is ever queued | Enforced at queue construction, not just in the UI | U |

## 6. Natural-language contact matching

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| NLM-01 | Query returns a ranked subset | Matches presented for confirmation | I |
| NLM-02 | Query matching nothing | Empty result with a clear message; no fallback to "everyone" | I |
| NLM-03 | **Matching never sends.** Any query, including one phrased as a command ("message all my customers now") | Produces a selection for confirmation only; no queue rows created | I |
| NLM-04 | Payload sent to the LLM | Contains no phone numbers, JIDs or message bodies | U |
| NLM-05 | LLM returns an id not present in the submitted index | Discarded, not queued | U |
| NLM-06 | LLM provider errors or times out | Error surfaced; user can still select manually | I |
| NLM-07 | User deselects matches before confirming | Only the remaining selection is queued | D |

## 7. Image generation, refinement and search

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| IMG-01 | Generate from a prompt | Object stored under the caller's prefix; `image_sessions` row created; client renders it | I |
| IMG-02 | Refine an existing session | New object stored, `current_path` advances, prior object retained for step-back | I |
| IMG-03 | Step back to a prior refinement | Earlier object still fetchable | I |
| IMG-04 | Provider exposes no edit endpoint | Falls back to an amended `generate()`; caller sees no difference | U |
| IMG-05 | Image search returns results | Thumbnails rendered, selectable | I |
| IMG-06 | Selecting a searched image | Stored under the caller's prefix like a generated one; `source = 'searched'` | I |
| IMG-07 | Provider returns an error | Surfaced to the user; no partial session row, no orphaned object | I |
| IMG-08 | Provider times out | Same as IMG-07, with a distinguishable message | I |
| IMG-09 | Prompt history accumulates across refinements | Ordered, complete, persisted | I |
| IMG-10 | Two concurrent refinements on one session | Serialized or the later rejected; `current_path` never left pointing at a missing object | I |

## 8. Image cache

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| CSH-01 | First view of an image | Downloaded, written to cache, `image_cache` row created | D |
| CSH-02 | Second view | Served from cache, no network request | D |
| CSH-03 | Cache exceeds the size budget | Evicted by `last_used_at`; the in-use image is not evicted | D |
| CSH-04 | Download returns 404 (object deleted by retention → RET-03) | Cache row and file dropped; placeholder shown; no crash loop | D |
| CSH-05 | OS reclaims `Directory.Cache` | Re-download transparently on next view | D |
| CSH-06 | Offline with the image cached | Renders from cache | D |
| CSH-07 | Offline with the image not cached | Clear "unavailable offline" state, no spinner that never resolves | D |

## 9. Save to photo library

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| SAV-01 | Save on Android 10+ | Appears in the Gallery app — verifies a MediaStore insert, not a bare file write | D |
| SAV-02 | Save on Android 9 or below | Requires `WRITE_EXTERNAL_STORAGE`; prompts and succeeds | D |
| SAV-03 | Permission denied | Error surfaced; image remains in the app | D |
| SAV-04 | Save the same image twice | No corruption; duplicate or overwrite, but deterministic | D |
| SAV-05 | Save with the device nearly out of storage | Fails cleanly with a real message | M |

## 10. WhatsApp session

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| WA-01 | First run | QR reaches the UI and renders — the bug in the original design was that it never did | D |
| WA-02 | QR scanned | Pairing completes, `connection: open` reported | D |
| WA-03 | App relaunched after pairing | Session restored from `useMultiFileAuthState`; no new QR | D |
| WA-04 | Network drops mid-session | `connection: close`, non-`loggedOut` → reconnects automatically | D |
| WA-05 | Repeated reconnect failures | Backoff increases and is capped; no tight retry loop | U |
| WA-06 | Logged out from the phone's WhatsApp app | `DisconnectReason.loggedOut` → prompts a new QR; does **not** enter a reconnect loop | D |
| WA-07 | Reconnect succeeds after failures | Attempt counter resets | U |
| WA-08 | QR expires unscanned | New QR issued | D |

## 11. Sending and queue durability

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| SEND-01 | Text send to a registered number | `SENT`; mirrored to `message_history`; `outbox` row removed | D |
| SEND-02 | Image send with caption | Delivered with the image; same status handling | D |
| SEND-03 | Send to an unregistered number | `SKIPPED`, not `FAILED` — distinct status | D |
| SEND-04 | `onWhatsApp()` check runs before queueing | Unregistered numbers never enter the queue | I |
| SEND-05 | Batch written to `outbox` before the first send attempt | All rows `PENDING` on disk before anything leaves | D |
| SEND-06 | App killed mid-batch, then relaunched | Unsent rows still `PENDING` and resume | D |
| SEND-07 | App killed after a send but before its result was recorded | Row is `CLAIMED`; on relaunch the user is asked, **not** silently resent | D |
| SEND-08 | Send fails with a transport error | `FAILED` with a reason; the batch continues to the next recipient | D |
| SEND-09 | Batch containing the same number twice | Sent once | U |
| SEND-10 | Socket disconnects mid-batch | Worker waits for readiness and resumes; does not mark the remainder failed | D |
| SEND-11 | Batch completes | `wa:batch-done` emitted; foreground service stops (→ AND-02) | D |
| SEND-12 | Empty batch submitted | Rejected before any service starts | U |
| SEND-13 | Supabase unreachable when mirroring a result | Retained in `outbox` and mirrored on reconnect; status not lost | D |

## 12. Pacing

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| PAC-01 | Interval between consecutive sends | Falls within the configured min/max window | U |
| PAC-02 | Intervals across a batch | Vary rather than being constant | U |
| PAC-03 | Sends are sequential | No two in flight at once | U |
| PAC-04 | Pacing settings changed | New window applied to the next batch | I |

## 13. Quotas and limits

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| QTA-01 | Generation within quota | Permitted; `usage_daily.images_generated` incremented | I |
| QTA-02 | Generation at the daily quota | Rejected with a quota error the client renders meaningfully | I |
| QTA-03 | Quota resets the next day | Permitted again | I |
| QTA-04 | Storage quota exceeded | Generation rejected before the provider is called — no cost incurred on a request that cannot be stored | I |
| QTA-05 | Batch exceeding `max_batch_recipients` | Rejected before any `outbox` row is written | I |
| QTA-06 | Quota checks are server-side | A client bypassing its own UI check is still refused | I |
| QTA-07 | A's usage does not consume B's quota | Counters are per-user | I |
| QTA-08 | Settings table empty on a fresh deploy | Seeded defaults apply; the system is not unlimited by accident | I |

## 14. Retention

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| RET-01 | Unsent session image past `unsent_image_ttl_days` | Object and session row deleted | I |
| RET-02 | Unsent image within TTL | Retained | I |
| RET-03 | Sent image past `sent_image_ttl_days` | Object deleted | I |
| RET-04 | `sent_image_ttl_days = 0` | Kept indefinitely | I |
| RET-05 | `message_history` referencing a deleted object | History row survives; placeholder rendered — history outlives the file | I |
| RET-06 | Dry run | Returns counts and byte totals only; no object paths, no per-user breakdown | I |
| RET-07 | Job interrupted partway | Re-runnable; no half-deleted state that breaks the next run | I |
| RET-08 | Retention across two users | Each user's objects evaluated independently; no cross-deletion | I |

## 15. Android platform

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| AND-01 | Batch starts | Foreground service starts; notification visible | D |
| AND-02 | Queue drains | Service stops; notification cleared | D |
| AND-03 | App backgrounded mid-batch | Sending continues | D |
| AND-04 | Screen off / device idle | Sending continues | D |
| AND-05 | API 33+ notification permission denied | Service behaviour is defined and the user is told why progress is not visible | D |
| AND-06 | API 34+ service start | Succeeds — confirms `FOREGROUND_SERVICE_DATA_SYNC` is declared | D |
| AND-07 | Android 14 six-hour `dataSync` cap reached | `onTimeout` handled; service stops cleanly; batch resumes later via `outbox` | M |
| AND-08 | OEM battery manager kills the process (Huawei/EMUI) | `outbox` intact; batch resumes on relaunch; user prompted to whitelist | M |
| AND-09 | No TCP port is listening | Port scan of the device finds nothing from this app — regression guard for the removed localhost server | D |
| AND-10 | nodejs-mobile payload on `arm64-v8a` | Loads and connects — the build-order gate | D |
| AND-11 | Device rotated / activity recreated mid-batch | Sending unaffected | D |

## 16. Cross-platform clients

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| XPL-01 | Browser client requests contacts | Reports unsupported; UI hides the capability rather than failing | I |
| XPL-02 | Browser client attempts a send | Unsupported; no partial queue state | I |
| XPL-03 | Browser client views image and send history | Renders fully — the payoff of server-side image storage | I |
| XPL-04 | Image generated on the browser, opened on Android | Same object, same session | I |
| XPL-05 | `admin-ui` assets absent from the Android bundle | Build-time assertion over the APK contents | U |

## 17. Consent and safety

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| SAF-01 | Batch confirmation | Recipient count shown prominently before sending | D |
| SAF-02 | Suppressed recipient included in a match | Excluded at queue construction, not merely hidden in the UI | U |
| SAF-03 | Recipient added to suppression | Never queued again, across sessions and devices | I |
| SAF-04 | Large batch | Confirmation is explicit enough that a mass send cannot happen by a single mistaken tap | M |
| SAF-05 | Client with no opt-in recorded (`opted_in_at` null), not opted out, included in a manual send, a browser-queued job and a scheduled greeting | Sent in all three — consent is opt-out (`crmex.md` §12); `opted_in_at` never gates sending | I |
| SAF-06 | Client opted out (`suppressed_at` set) while a manual batch, a queued `send_jobs` row and a scheduled reminder are pending | Excluded from all three; pending client-audience reminders cancelled; the queued job skips the client at claim time | I |

## 18. Firm isolation (multi-tenancy)

The firm axis of the isolation suite (`crmex.md` §15.9). A tenancy bug leaks privileged client information between law firms, so every case is run against both tenants and, where it matters, against a user who belongs to both.

**Fixtures** (in addition to User A / User B):

- **Firm A** with **A1** (`owner`) and **A2** (`member`); **Firm B** with **B1** (`owner`). A1/A2/B1 are distinct accounts — never reuse User A/B's single-firm setup for these cases.
- **X** — a member of both Firm A and Firm B. Several holes (moving a row between firms, cross-firm links) are only reachable by a user whose RLS admits both firms; a suite without X cannot detect them.
- **Demo Firm** (`00000000-0000-4000-8000-00000000d3e0`) — the backfill target for pre-tenancy data.

Cases TEN-01–TEN-26 are database-level and are also executed against the migrations in PGlite (Postgres compiled to WASM, with stubbed `auth`/`storage` schemas and the `anon`/`authenticated`/`service_role` roles) before a migration is applied to a real project; the **I** level means they must additionally pass against a real Supabase test project through supabase-js. In the expectations, "rejected" means an error (RLS `WITH CHECK`, missing grant, trigger or constraint); "zero rows" means the statement succeeds but RLS filters every target row.

### 18.1 Postgres — schema, grants and helpers

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| TEN-01 | Catalog audit: RLS flag and grants on every `public` table | RLS enabled on all; `anon` holds no privileges on firm or tenancy tables; `authenticated` holds only `SELECT` on `organizations`/`org_members`/`org_invitations`/`org_audit_log`, nothing on `org_usage_daily`, and no `TRUNCATE` anywhere (RLS does not govern `TRUNCATE`) | I |
| TEN-02 | Membership helpers `is_org_member` / `has_org_role` / `is_org_member_folder` | `SECURITY DEFINER` with pinned `search_path`; `anon` cannot execute them (Supabase grants function `EXECUTE` to `anon` by default — revoking from `PUBLIC` is not enough); for B1 they return false for Firm A | I |

### 18.2 Postgres — CRM tables (`clients`, `matters`, `matter_clients`, `tasks`)

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| TEN-03 | A1/A2 insert clients, matters, links and tasks into Firm A | Permitted; `created_by` defaults to the caller | I |
| TEN-04 | A1 and A2 read and update Firm A rows, including rows the other created | Both see identical Firm A data; updates succeed; `updated_at` advances. X, unfiltered, sees both firms' rows — the client must filter by the active `org_id` | I |
| TEN-05 | B1 selects every CRM table, `org_members` and `organizations` | Zero Firm A rows | I |
| TEN-06 | B1 inserts a row with `org_id = Firm A` into each CRM table; A1 inserts with `created_by` = another user | Rejected | I |
| TEN-07 | B1 updates or deletes Firm A rows by id | Zero rows affected | I |
| TEN-08 | Move a row between firms: B1 sets its own client's `org_id` to Firm A; X does the same for clients and matters; the service role does the same | Rejected in every case (`org_id` is immutable). An update that re-sends an unchanged `org_id` is permitted. `created_by` cannot be reassigned | I |
| TEN-09 | X and B1 create a `matter_clients` link between a Firm A matter and a Firm B client (with either `org_id`); same as the service role | Rejected by the composite foreign key — a link can never cross firms | I |
| TEN-10 | Task `matter_id` or `message_history.client_id` pointing at another firm's row (insert and update) | Rejected by the composite foreign key; same-firm reference permitted | I |
| TEN-11 | Task assigned to a user outside the firm (insert, reassign, and via the service role) | Rejected; assigning a member of the firm is permitted | I |
| TEN-12 | Duplicate `phone_e164` or `matter_number` inside a firm; the same values in another firm; invalid E.164; blank `display_name` | Duplicates and invalid values rejected; the same phone or matter number in another firm permitted | I |
| TEN-13 | A2 (`member`) deletes a client and a matter; A2 as `admin` and A1 as `owner` do the same; any member deletes tasks and links | Member: zero rows for clients/matters, permitted for tasks/links. Admin/owner: permitted. Deleting a matter nulls only `tasks.matter_id`; deleting a client nulls `message_history.client_id` and keeps the history row | I |

### 18.3 Postgres — tenancy tables, anon, shared tables

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| TEN-14 | Any authenticated user inserts/updates/deletes `organizations`, `org_members` (including self-promotion and joining Firm B), `org_invitations`, `org_audit_log`; reads `org_usage_daily` | Rejected — firm creation, membership and invitations are service-role only. Owners/admins read their firm's invitations and audit log; members and other firms read none | I |
| TEN-15 | `anon` reads every tenancy and firm table and `storage.objects` | Rejected (no grant) for tables; zero storage objects | I |
| TEN-16 | `message_history`: B1 inserts into Firm A; A1 inserts with another `user_id`; A2 reads A1's sends; B1 reads Firm A's; A1 updates a row | Cross-firm and misattributed inserts rejected; A2 sees A1's sends; B1 sees none; client updates affect zero rows | I |
| TEN-17 | `contact_meta`: A2 upserts (`onConflict: 'org_id,jid'`) a row A1 last wrote; B1 updates Firm A rows; X moves a row to Firm B | A2's upsert permitted and `user_id` becomes A2; B1 zero rows; move rejected | I |
| TEN-19 | Tenancy migration on a project with existing users and data (including two users holding `contact_meta` for the same jid), then re-run after a new sign-up | Every pre-existing account is `owner` of Demo Firm; all legacy rows get Demo Firm's `org_id` and the column is `NOT NULL`; duplicate `contact_meta` rows merged (tags unioned — a `suppressed` tag survives) before the `(org_id, jid)` key; `org_usage_daily` seeded from `usage_daily` sums; the re-run does not enrol the new account | I |
| TEN-20 | Service role removes A2 from Firm A; A2 then reads and writes | Access ends on the very next statement: zero Firm A rows, zero Firm A storage objects, inserts rejected | I |
| TEN-21 | `core-server` service role reads/writes across firms (organizations, memberships, `org_usage_daily`, `image_sessions`) | Permitted — RLS does not block the service role; the `org_id` immutability, composite FK and assignee checks still apply to it | I |
| TEN-22 | An auth account that created clients, matters, tasks, `message_history`, `image_sessions`, `contact_meta` and `send_jobs` (one queued, one claimed) is deleted | Deletion succeeds; every row stays with the firm with `user_id`/`created_by = null` and is still readable by the other members. The creator-less jobs cannot be claimed, cancelled or finished by anyone (members: zero rows; service role: rejected). Inserts with a null `user_id`/`created_by` are still rejected | I |

### 18.4 Storage

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| TEN-18 | Objects at `<Firm A>/<A1>/…`, `<Firm B>/<B1>/…`, a legacy `<user_id>/…` path, a non-uuid folder, a top-level object, and a Firm A path in another bucket | A2 reads A1's Firm A object (upper-case uuid folder too); B1 reads only Firm B's; legacy, non-uuid and top-level paths denied without a cast error; client upload and delete denied; other buckets unaffected | I |
| TEN-27 | B1 requests a signed URL (`createSignedUrl`) for a Firm A object path with B1's JWT | Denied; no URL issued | I |

### 18.5 Phone-dispatched sending (`send_jobs`, `crmex.md` §15.10)

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| TEN-23 | A1 queues a job; A2 and B1 read; invalid inserts (status other than `queued`, `created_by` = someone else, into another firm, a `client_id` from another firm, empty or non-array `recipients`, a recipient without `jid`, neither `body` nor `media_path`) | Defaults `queued` / caller / generated `recipient_count`; A2 sees it, B1 does not; every invalid insert rejected | I |
| TEN-24 | A2 and B1 claim or cancel A1's job; A1 claims twice with `… where status = 'queued'`; A1 re-claims without the status filter; A1 updates only `error` while claimed | Others: zero rows. First claim returns exactly one row with `claimed_at` set by the database; second claim returns zero rows; the unfiltered re-claim is rejected; the error-only update is permitted | I |
| TEN-25 | Illegal transitions and edits: `claimed → cancelled`, `done → queued` (also as service role), changing `recipients`/`body` after insert, moving a job to another firm, deleting a job; legal `claimed → done` with a client-supplied `finished_at`; `queued → cancelled` | Illegal ones rejected (or zero rows for a non-creator); `finished_at` is set by the database, ignoring the client value | I |
| TEN-26 | Migration adds `send_jobs` to `supabase_realtime`, run twice | Table in the publication exactly once; migration succeeds where the publication does not exist | I |
| TEN-28 | Two devices signed in as A1 receive the same job over Realtime and claim concurrently | Exactly one device's claim returns the row; only that device sends | D |
| TEN-29 | B1 subscribes to `send_jobs` changes over Realtime | Receives no Firm A events (Realtime applies B1's SELECT policy) | I |

### 18.6 `core-server`

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| TEN-30 | B1 calls a firm-scoped route with `X-Org-Id: <Firm A>` | 403 — membership is looked up from the database; the header is a selector, never an authority | I |
| TEN-31 | Firm-scoped route with no, malformed, or non-existent `X-Org-Id` | 400/403; nothing read or written | I |
| TEN-32 | A2 (`member`) creates or revokes an invitation, removes a member or changes a role | 403 | I |
| TEN-33 | Owner removes the last owner of a firm | Rejected | I |
| TEN-34 | Email-addressed invitation accepted by a user whose verified email differs; token reused; expired or revoked token | Rejected; single-use token cannot create a second membership | I |
| TEN-35 | A1 and B1 generate images with the identical prompt | Two objects under `<Firm A>/<A1>/…` and `<Firm B>/<B1>/…`; neither receives the other's (extends ISO-20 with `org_id` in the cache key) | I |
| TEN-36 | Operator (platform admin) directory routes | Firms and members only; no clients, matters, tasks, messages, images or per-member counts; every read written to `admin_audit_log` | I |
| TEN-37 | Device: switch the active firm from A to B with unsent `outbox` rows for Firm A | Firm A rows are never replayed while Firm B is active; the firm list is re-validated on launch and a removed membership purges that firm's local cache | D |

## 19. Scheduling, processes and reminders (`crmex.md` §16)

Designed, not implemented. Uses the §18 two-firm fixture (Firm A: A1, A2; Firm B: B1).

| ID | Scenario | Expected | Level |
| :--- | :--- | :--- | :--- |
| SCH-01 | B1 selects, inserts or updates Firm A events, templates, reminders or notifications, or calls `apply_process` / `preview_move` / `apply_move` with Firm A ids | Zero rows / not found; nothing written | I |
| SCH-02 | `anchor_event_id`, `process_id`, `matter_id`, `client_id` or `recurrence_of` pointing at another firm's row, including as service role | Rejected by the composite FK | I |
| SCH-03 | `apply_process` on a template with negative offsets, month offsets landing on the 31st, and a cyclic template | Steps created in dependency order with correct dates (months clamped to month end); cyclic template rejected; steps already in the past flagged, not failed | I |
| SCH-04 | Move an event with `projected`, `manual`, `fixed` and `done` dependents | Only `projected` dependents move; `manual`/`fixed` stay and are reported as conflicts; `done` never moves; one `event_changes` row per moved event | I |
| SCH-05 | `apply_move` with a preview hash that is stale because another member moved a dependent | Refused; nothing written | I |
| SCH-06 | Move an event whose reminders are sent, scheduled, and would now fall in the past | `fire_at` recalculated and `generation` bumped; future reminders re-armed; a dispatcher retry of the old generation delivers nothing | I |
| SCH-07 | "09:00 local" event and reminder across a DST change in the firm timezone | `starts_at` / `fire_at` are 09:00 local on both sides of the change | U |
| SCH-08 | Two dispatcher instances claim the same due reminders concurrently | Each staff reminder delivered once per recipient; at most one `send_jobs` row per client reminder | I |
| SCH-09 | A2 removed from Firm A before a reminder addressed to them fires; a client reminder whose `sender_id` has been removed | A2 receives nothing; the client reminder is skipped | I |
| SCH-10 | Client reminder for an opted-out client, a client with no phone, and a client with no opt-in recorded | First two skipped with a notification to the sender; the third is **sent** | I |
| SCH-11 | Scheduled `send_jobs` row not claimed before `expires_at` | Phone claim returns zero rows; dispatcher moves it to `expired` and notifies the sender | I |
| SCH-12 | `tentative` hearing within 30 days not confirmed; `scheduled` event 2 h and 24 h past its end without an outcome | "Not confirmed" to the assignee; "Did it happen?" at 2 h; escalation to owners/admins at 24 h | I |
| SCH-13 | Dispatcher down for 12 h, then resumes | Staff reminders delivered, marked late, collapsed per user above 5; client reminders past their window skipped with a notification | I |
| SCH-14 | Yearly event marked done, including a 29 Feb birthday | Exactly one next occurrence, with its reminders; 28 Feb in non-leap years | I |
| SCH-15 | A2 creates or edits a client-audience reminder with `sender_id = A1`; A2 cancels A1's client reminder | Create/edit rejected; cancel permitted | I |
| SCH-16 | Device: sign out; membership of a firm fails re-validation on launch | All local notifications cleared on sign-out; that firm's local notifications dropped | D |

---

## Deferred

Admin portal UI cases (screens, dashboards, settings forms) are deferred with the portal itself. Its **server-side** gates are not deferred and are covered above: ROLE-01–05, QTA-01–08, RET-01–08.

When the portal is built, add cases for: aggregate-only queries returning no user dimension, the provider screen never returning key material, audit-log append-only enforcement, and `admin-ui` being unreachable from the user-facing hosts.

## Deliberately not covered

- **AI output quality.** Whether a generated image is *good* is not testable here. Tests assert that a well-formed image is produced, stored and rendered.
- **WhatsApp delivery at volume.** See Constraints — verified through queue state and timing, never by sending at scale.
- **Baileys protocol internals.** Treated as an external dependency; tests cover this system's handling of its events and errors, not its correctness.
- **iOS and Electron.** Out of scope for this phase.
