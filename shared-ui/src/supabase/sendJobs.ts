// send_jobs (crmex.md §15.10): a browser queues a send; the sender's own
// phone claims it atomically and runs it through the normal outbox path.
// The job id doubles as the batch_id of the resulting message_history rows.
// The database sets claimed_at / finished_at itself and rejects illegal
// status transitions (supabase/migrations/20260913000200_send_jobs.sql).
import type { SupabaseClient } from '@supabase/supabase-js';
import { jidFromE164 } from '../contacts/normalize.js';
import type { SendJobRecipient, SendJobRow, SendJobStatus } from '../crm/types.js';
import { CrmPermissionError } from './crmRepo.js';

export interface QueueSendJobInput {
  orgId: string;
  userId: string;
  body?: string | null;
  mediaPath?: string | null;
  /** Client ids the user confirmed in review. Phone numbers are re-read from the firm's clients, never taken from the caller. */
  clientIds: string[];
}

export interface QueuedJob {
  job: SendJobRow;
  /** Selected clients left out because they opted out, lost their phone number or no longer exist. */
  excludedClientIds: string[];
}

const E164_RE = /^\+[1-9][0-9]{6,14}$/;

/**
 * limits.max_batch_recipients lives in app_settings, which clients cannot
 * read; the seeded default is mirrored here until a read path exists. The
 * phone re-checks it at claim time (§15.10) because the DB does not enforce it.
 */
export const MAX_BATCH_RECIPIENTS = 200;

export async function queueSendJob(client: SupabaseClient, input: QueueSendJobInput): Promise<QueuedJob> {
  if (!input.orgId) throw new Error('ORG_REQUIRED: no active firm');
  const ids = Array.from(new Set(input.clientIds));
  if (ids.length === 0) throw new Error('EMPTY_BATCH');
  if (!input.body?.trim() && !input.mediaPath) throw new Error('EMPTY_MESSAGE');

  // Fail closed: recipients are rebuilt from the firm's current client rows.
  const { data, error } = await client.from('clients').select('id, display_name, phone_e164, suppressed_at').eq('org_id', input.orgId).in('id', ids);
  if (error) throw error;
  const found = new Map(((data ?? []) as { id: string; display_name: string; phone_e164: string | null; suppressed_at: string | null }[]).map((c) => [c.id, c]));

  const recipients: SendJobRecipient[] = [];
  const excludedClientIds: string[] = [];
  const seenJids = new Set<string>();
  for (const id of ids) {
    const c = found.get(id);
    if (!c || c.suppressed_at || !c.phone_e164 || !E164_RE.test(c.phone_e164)) {
      excludedClientIds.push(id);
      continue;
    }
    const jid = jidFromE164(c.phone_e164);
    if (seenJids.has(jid)) continue;
    seenJids.add(jid);
    recipients.push({ client_id: c.id, jid, display_name: c.display_name });
  }
  if (recipients.length === 0) throw new Error('NO_SENDABLE_RECIPIENTS');
  if (recipients.length > MAX_BATCH_RECIPIENTS) throw new Error('BATCH_TOO_LARGE');

  const inserted = await client
    .from('send_jobs')
    .insert({
      org_id: input.orgId,
      created_by: input.userId,
      status: 'queued',
      body: input.body?.trim() || null,
      media_path: input.mediaPath ?? null,
      recipients,
    })
    .select('*');
  if (inserted.error) throw inserted.error;
  const job = ((inserted.data ?? []) as SendJobRow[])[0];
  if (!job) throw new CrmPermissionError();
  return { job, excludedClientIds };
}

export async function getSendJob(client: SupabaseClient, orgId: string, id: string): Promise<SendJobRow | null> {
  const { data, error } = await client.from('send_jobs').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as SendJobRow | null) ?? null;
}

export async function listSendJobs(client: SupabaseClient, orgId: string, opts: { statuses?: SendJobStatus[]; limit?: number } = {}): Promise<SendJobRow[]> {
  if (!orgId) throw new Error('ORG_REQUIRED: no active firm');
  let q = client.from('send_jobs').select('*').eq('org_id', orgId);
  if (opts.statuses) q = q.in('status', opts.statuses);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(opts.limit ?? 50);
  if (error) throw error;
  return (data ?? []) as SendJobRow[];
}

/** Cancels the caller's own job while it is still queued. Throws once a phone has claimed it. */
export async function cancelSendJob(client: SupabaseClient, orgId: string, userId: string, id: string): Promise<SendJobRow> {
  const { data, error } = await client
    .from('send_jobs')
    .update({ status: 'cancelled' })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('created_by', userId)
    .eq('status', 'queued')
    .select('*');
  if (error) throw error;
  const row = ((data ?? []) as SendJobRow[])[0];
  if (!row) throw new Error('This message can no longer be cancelled — your phone has already started sending it.');
  return row;
}

/** The caller's own queued jobs in the given firms, oldest first. */
export async function listRunnableJobs(client: SupabaseClient, userId: string, orgIds: string[]): Promise<SendJobRow[]> {
  if (orgIds.length === 0) return [];
  const { data, error } = await client
    .from('send_jobs')
    .select('*')
    .eq('created_by', userId)
    .eq('status', 'queued')
    .in('org_id', orgIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SendJobRow[];
}

/**
 * Atomic claim: only a still-queued job created by this user flips to
 * claimed. Returns the row only if exactly one row changed, so two devices
 * can never both run a job.
 */
export async function claimSendJob(client: SupabaseClient, userId: string, job: Pick<SendJobRow, 'id' | 'org_id'>): Promise<SendJobRow | null> {
  const { data, error } = await client
    .from('send_jobs')
    .update({ status: 'claimed' })
    .eq('id', job.id)
    .eq('org_id', job.org_id)
    .eq('status', 'queued')
    .eq('created_by', userId)
    .select('*');
  if (error) throw error;
  const list = (data ?? []) as SendJobRow[];
  return list.length === 1 ? list[0] : null;
}

export async function finishSendJob(
  client: SupabaseClient,
  userId: string,
  job: Pick<SendJobRow, 'id' | 'org_id'>,
  status: 'done' | 'failed',
  errorMessage: string | null = null,
): Promise<void> {
  const { error } = await client
    .from('send_jobs')
    .update({ status, error: errorMessage })
    .eq('id', job.id)
    .eq('org_id', job.org_id)
    .eq('created_by', userId)
    .eq('status', 'claimed');
  if (error) throw error;
}

/** Realtime subscription to send_jobs changes matching one column filter. Returns an unsubscribe function. */
export function subscribeSendJobs(
  client: SupabaseClient,
  filter: { column: 'created_by' | 'org_id' | 'id'; value: string },
  onChange: (row: SendJobRow) => void,
): () => void {
  const channel = client
    .channel(`send_jobs:${filter.column}:${filter.value}:${Math.random().toString(36).slice(2)}`)
    .on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table: 'send_jobs', filter: `${filter.column}=eq.${filter.value}` } as never,
      ((payload: { new?: SendJobRow }) => {
        if (payload.new && (payload.new as SendJobRow).id) onChange(payload.new as SendJobRow);
      }) as never,
    )
    .subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
