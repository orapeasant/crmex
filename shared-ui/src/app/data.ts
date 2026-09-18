// Screen-independent data loaders shared by the phone UI and the desktop web
// portal. Each one takes the active firm explicitly and only calls the
// org-scoped repositories, so both shells get the same tenancy guarantees.
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientRecipients, suppressedJidsOf, type RecipientContact } from '../crm/clients.js';
import { groupHistoryBatches } from '../crm/history.js';
import type { MatterClientRole, MatterRow, OrgMemberRow, SendJobRow } from '../crm/types.js';
import { buildQueue, type BuiltQueue } from '../send/queueBuilder.js';
import { listClients, listMatterClients, listMatters, listMessageHistory, listOrgMemberRows } from '../supabase/crmRepo.js';
import type { MessageHistoryRow } from '../supabase/repo.js';
import { getSendJob, listSendJobs } from '../supabase/sendJobs.js';

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  when: string;
  senderId: string | null;
  body: string | null;
  hasMedia: boolean;
  total: number;
  sent: number;
  failed: number;
  /** send_jobs status when the batch was queued from a browser. */
  jobStatus: SendJobRow['status'] | null;
}

/** Sent batches (message_history) merged with browser-queued send_jobs, newest first. */
export async function loadBatchHistory(supabase: SupabaseClient, orgId: string): Promise<{ entries: HistoryEntry[]; members: OrgMemberRow[] }> {
  const [rows, jobs, members] = await Promise.all([
    listMessageHistory(supabase, orgId, { limit: 500 }),
    // send_jobs may not exist on older databases; history still works without it.
    listSendJobs(supabase, orgId, { limit: 50 }).catch(() => [] as SendJobRow[]),
    listOrgMemberRows(supabase, orgId).catch(() => [] as OrgMemberRow[]),
  ]);
  const entries = new Map<string, HistoryEntry>();
  for (const b of groupHistoryBatches(rows)) {
    entries.set(b.batchId, { id: b.batchId, when: b.startedAt, senderId: b.senderId, body: b.body, hasMedia: Boolean(b.mediaPath), total: b.total, sent: b.sent, failed: b.failed, jobStatus: null });
  }
  for (const j of jobs) {
    const e = entries.get(j.id);
    if (e) {
      e.jobStatus = j.status;
      e.total = Math.max(e.total, j.recipients.length);
      e.when = j.created_at;
    } else {
      entries.set(j.id, { id: j.id, when: j.created_at, senderId: j.created_by, body: j.body, hasMedia: Boolean(j.media_path), total: j.recipients.length, sent: 0, failed: 0, jobStatus: j.status });
    }
  }
  return { entries: Array.from(entries.values()).sort((a, b) => b.when.localeCompare(a.when)), members };
}

export interface BatchData {
  job: SendJobRow | null;
  rows: MessageHistoryRow[];
  members: OrgMemberRow[];
}

export async function loadBatch(supabase: SupabaseClient, orgId: string, batchId: string): Promise<BatchData> {
  const [job, rows, members] = await Promise.all([
    getSendJob(supabase, orgId, batchId).catch(() => null),
    listMessageHistory(supabase, orgId, { batchId }),
    listOrgMemberRows(supabase, orgId).catch(() => [] as OrgMemberRow[]),
  ]);
  return { job, rows, members };
}

export type BatchRecipientStatus = 'QUEUED' | 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface BatchRecipient {
  key: string;
  name: string;
  phone: string;
  status: BatchRecipientStatus;
  /** error_reason code, e.g. SUPPRESSED / NOT_ON_WHATSAPP. */
  reason: string | null;
}

/** Per-recipient rows: mirrored results, plus job recipients the phone hasn't reported yet. */
export function batchRecipients({ job, rows }: Pick<BatchData, 'job' | 'rows'>): BatchRecipient[] {
  const byJid = new Map(rows.map((r) => [r.jid, r]));
  const list: BatchRecipient[] = rows.map((r) => ({ key: String(r.id), name: r.display_name || `+${r.jid.split('@')[0]}`, phone: `+${r.jid.split('@')[0]}`, status: r.status, reason: r.error_reason }));
  for (const r of job?.recipients ?? []) {
    if (!byJid.has(r.jid)) list.push({ key: r.jid, name: r.display_name, phone: `+${r.jid.split('@')[0]}`, status: 'QUEUED', reason: null });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function loadClientMatters(supabase: SupabaseClient, orgId: string, clientId: string): Promise<{ matter: MatterRow; role: MatterClientRole }[]> {
  const [links, all] = await Promise.all([listMatterClients(supabase, orgId, { clientId }), listMatters(supabase, orgId)]);
  const byId = new Map(all.map((m) => [m.id, m]));
  return links.flatMap((l) => {
    const m = byId.get(l.matter_id);
    return m ? [{ matter: m, role: l.role }] : [];
  });
}

// ---------------------------------------------------------------------------
// Sending: the review check before a batch may be sent or queued
// ---------------------------------------------------------------------------

export interface ReviewQueueInput {
  supabase: SupabaseClient;
  orgId: string;
  /** Recipients the user selected. */
  selected: RecipientContact[];
  body: string;
  mediaPath: string | null;
  /** WhatsApp registration check; null when this device has no WhatsApp session (queue mode). */
  checkRegistered: ((jids: string[]) => Promise<Record<string, boolean>>) | null;
}

/**
 * Fail closed: suppression is re-read from the firm's clients now, not taken
 * from the list shown earlier (SAF-03), and everything goes through buildQueue.
 */
export async function buildReviewQueue({ supabase, orgId, selected, body, mediaPath, checkRegistered }: ReviewQueueInput): Promise<BuiltQueue> {
  const fresh = await listClients(supabase, orgId);
  const suppressedJids = suppressedJidsOf(fresh);
  const stillValid = new Map(clientRecipients(fresh).recipients.map((c) => [c.id, c]));
  for (const c of selected) if (!stillValid.has(c.id)) suppressedJids.add(c.jid);
  const jids = Array.from(new Set(selected.map((c) => c.jid)));
  // Queue mode can't reach WhatsApp; the phone repeats this check when it claims the job.
  const registered: Record<string, boolean> = checkRegistered ? await checkRegistered(jids) : Object.fromEntries(jids.map((j) => [j, true]));
  return buildQueue({
    candidates: selected.map((contact) => ({ contact, registeredOnWhatsApp: registered[contact.jid] ?? 'unknown', clientId: contact.clientId })),
    confirmedJids: new Set(jids),
    suppressedJids,
    body: body.trim() || undefined,
    mediaPath,
  });
}

// ---------------------------------------------------------------------------
// Usage (the signed-in user's own activity in the active firm)
// ---------------------------------------------------------------------------

export interface UsageStats {
  sentToday: number;
  sent30d: number;
  failed30d: number;
  images30d: number;
}

async function countRows(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** message_history and image_sessions are firm-readable under RLS, so both org and user are filtered. */
export async function loadUsageStats(supabase: SupabaseClient, orgId: string, userId: string, now = new Date()): Promise<UsageStats> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const history = () => supabase.from('message_history').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('user_id', userId);
  const [sentToday, sent30d, failed30d, images30d] = await Promise.all([
    countRows(history().eq('status', 'SENT').gte('created_at', startOfToday.toISOString())),
    countRows(history().eq('status', 'SENT').gte('created_at', since30d)),
    countRows(history().eq('status', 'FAILED').gte('created_at', since30d)),
    countRows(supabase.from('image_sessions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('user_id', userId).gte('created_at', since30d)),
  ]);
  return { sentToday, sent30d, failed30d, images30d };
}
