// Core cross-platform types. No platform-specific imports allowed in this file
// or in any file under shared-ui/src/components — see crmex.md §11.
import type { CountryCode as LibCountryCode } from 'libphonenumber-js';

// Re-exported so every module in this package (and android/) uses the exact
// same CountryCode type as libphonenumber-js's parser — a looser `string`
// alias here would let a caller pass a value normalizeContacts() can't
// actually accept and only find out at the type-check boundary between
// packages instead of at the call site.
export type CountryCode = LibCountryCode;

export interface NormalizedContact {
  id: string; // `${contactId}:${e164}`
  displayName: string;
  e164: string; // '+201234567890'
  jid: string; // '201234567890@s.whatsapp.net'
}

export interface NeedsReviewContact {
  id: string;
  displayName: string;
  raw: string;
}

export interface ContactListResult {
  usable: NormalizedContact[];
  needsReview: NeedsReviewContact[];
}

// Compact index sent to core-server for NL matching. Deliberately excludes
// phone numbers, JIDs and message bodies (crmex.md §7.4, test NLM-04).
export interface ContactIndexEntry {
  id: string;
  displayName: string;
  tags?: string[];
  notes?: string;
  lastContactAt?: string; // ISO timestamp
}

export interface PromptHistoryEntry {
  role: 'user' | 'assistant';
  prompt: string;
  timestamp: string;
}

export interface ImageSessionResult {
  sessionId: string;
  path: string;
  signedUrl: string;
  promptHistory: PromptHistoryEntry[];
}

export interface ImageSearchResult {
  id: string;
  thumbUrl: string;
  sourceUrl: string;
  source: string;
}

export type ApiErrorCode = 'QUOTA_EXCEEDED' | 'NOT_FOUND' | 'UNAUTHORIZED' | string;

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// --- Firms (tenants), crmex.md §15 ---

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrgSummary {
  id: string;
  name: string;
  plan: string;
  role: OrgRole;
  createdAt: string;
}

export interface OrgMember {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: OrgRole;
  joinedAt: string;
}

export interface OrgInvitation {
  id: string;
  email: string | null;
  role: Exclude<OrgRole, 'owner'>;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvitation {
  invitation: OrgInvitation;
  /** Plaintext single-use token — returned once, never retrievable again. */
  token: string;
  /** crmex://invite/<token> — encoded in the QR code and the email link. */
  inviteUrl: string;
}

// Everything server-side goes through one client, which attaches the Supabase JWT.
// Matches the /api/v1 contract exactly (see project brief); method names differ
// slightly from the narrower sketch in crmex.md §11, which this supersedes.
export interface ApiClient {
  health(): Promise<{ ok: true }>;
  matchContacts(query: string, index: ContactIndexEntry[]): Promise<string[]>;
  draftMessage(prompt: string): Promise<string>;
  generateImage(prompt: string): Promise<ImageSessionResult>;
  refineImage(sessionId: string, instruction: string): Promise<ImageSessionResult>;
  searchImages(query: string, limit?: number): Promise<ImageSearchResult[]>;
  selectSearchImage(sourceUrl: string, query: string): Promise<ImageSessionResult>;
}

// --- Outbox / send batch ---

export type OutboxStatus = 'PENDING' | 'CLAIMED' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface OutboxRow {
  id: number;
  userId: string;
  /** Firm the batch was sent from — the mirror writes history to this firm, never the currently active one. */
  orgId: string;
  batchId: string;
  jid: string;
  /** CRM client the message went to, recorded as message_history.client_id. */
  clientId?: string | null;
  displayName?: string | null;
  body?: string;
  mediaPath?: string | null;
  status: OutboxStatus;
  attempts: number;
  claimedAt?: number | null;
}

export interface OutboxBatchItem {
  id: number; // outbox row id
  jid: string;
  body?: string;
  mediaBytesBase64?: string; // populated only at IPC handoff time, not persisted in outbox table
}

export interface OutboxBatch {
  batchId: string;
  items: OutboxBatchItem[];
}

export interface SendResultEvent {
  id: number;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string;
}

// --- Image cache ---

export interface ImageCacheRow {
  mediaPath: string;
  userId: string;
  localFile: string;
  bytes: number;
  cachedAt: number;
  lastUsedAt: number;
}

// --- Local storage abstraction (SQLite on device, IndexedDB in browser) ---
export interface LocalStore {
  // outbox
  insertOutboxBatch(userId: string, orgId: string, batchId: string, items: OutboxInsertItem[]): Promise<OutboxRow[]>;
  claimOutboxRow(id: number, now: number): Promise<void>;
  settleOutboxRow(id: number, status: OutboxStatus): Promise<void>;
  deleteOutboxRow(id: number): Promise<void>;
  listPendingOutbox(userId: string): Promise<OutboxRow[]>;
  listClaimedUnsettled(userId: string): Promise<OutboxRow[]>;
  /** Rows with a final status (SENT/FAILED/SKIPPED) that still exist because
   * mirroring to Supabase failed (SEND-13) — retry the mirror, never the send. */
  listSettledUnmirrored(userId: string): Promise<OutboxRow[]>;

  // image cache
  getCacheRow(userId: string, mediaPath: string): Promise<ImageCacheRow | null>;
  putCacheRow(row: ImageCacheRow): Promise<void>;
  touchCacheRow(userId: string, mediaPath: string, now: number): Promise<void>;
  deleteCacheRow(userId: string, mediaPath: string): Promise<void>;
  listCacheByUser(userId: string): Promise<ImageCacheRow[]>;
  purgeUser(userId: string): Promise<void>;
  /** Drops this user's outbox rows for a firm they are no longer a member of (crmex.md §15.6). */
  purgeOrg(userId: string, orgId: string): Promise<void>;
}

export interface OutboxInsertItem {
  jid: string;
  clientId?: string | null;
  displayName?: string | null;
  body?: string;
  mediaPath?: string | null;
}

// Everything platform-specific goes through one bridge.
export interface NativeBridge {
  listContacts(defaultRegion: CountryCode): Promise<ContactListResult>;
  saveImageToLibrary(bytes: Blob | ArrayBuffer, filename: string): Promise<void>;
  signInWithGoogle(): Promise<{ idToken: string }>;
  sendBatch(batch: OutboxBatch): Promise<void>;
  onSendResult(cb: (evt: SendResultEvent) => void): () => void;
  onBatchDone(cb: (evt: { batchId: string }) => void): () => void;
  onWhatsAppState(cb: (evt: { type: 'qr' | 'ready' | 'logged-out' | 'close'; payload?: unknown }) => void): () => void;
  getSimRegion(): Promise<CountryCode | null>;
  storage: LocalStore;
}
