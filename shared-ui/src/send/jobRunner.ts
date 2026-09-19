// Phone-side runner for send_jobs queued from a browser (crmex.md §15.10).
// Only ever runs jobs created by the signed-in user (it is their WhatsApp
// account), claims each atomically, re-checks suppression and WhatsApp
// registration at claim time, then sends through the normal durable path
// using the job id as the batch id.
import type { SupabaseClient } from '@supabase/supabase-js';
import { suppressedJidsOf } from '../crm/clients.js';
import { isJobExpired, type SendJobRow } from '../crm/types.js';
import { windowForJob, type PacingWindow } from '../pacing/pacing.js';
import { mirrorMessageResult } from '../supabase/repo.js';
import { MAX_BATCH_RECIPIENTS, claimSendJob, finishSendJob, listRunnableJobs, subscribeSendJobs } from '../supabase/sendJobs.js';
import { buildQueue, type BuiltQueue, type SkippedEntry } from './queueBuilder.js';

export interface JobRunnerDeps {
  supabase: SupabaseClient;
  userId: string;
  checkRegistered(jids: string[]): Promise<Record<string, boolean>>;
  /** Send the queue, paced by `window` (the job's own pacing, or the firm default — §18.5), and resolve once the whole batch has finished. */
  sendBatch(orgId: string, batchId: string, queue: BuiltQueue, window: PacingWindow): Promise<void>;
}

export type JobOutcome = 'not-claimed' | 'expired' | 'done' | 'failed';

export async function runSendJob(deps: JobRunnerDeps, job: SendJobRow): Promise<JobOutcome> {
  const { supabase, userId } = deps;
  if (job.created_by !== userId || job.status !== 'queued') return 'not-claimed';
  // §18.3.2: a job past its window is never claimed, even if it reaches here (e.g. a
  // realtime push that arrived late). The dispatcher sweep is what moves it to `expired`
  // server-side; this is the phone's own on-sight check for when that sweep hasn't run yet.
  if (isJobExpired(job)) return 'expired';
  const claimed = await claimSendJob(supabase, userId, job);
  if (!claimed) return 'not-claimed';

  try {
    const recipients = Array.isArray(claimed.recipients) ? claimed.recipients : [];
    if (recipients.length > MAX_BATCH_RECIPIENTS) {
      await finishSendJob(supabase, userId, claimed, 'failed', `Too many recipients (limit ${MAX_BATCH_RECIPIENTS}).`);
      return 'failed';
    }
    // Suppression and status are re-read now, not trusted from queue time: a client may
    // have opted out or gone inactive since (§18.3.1, §18.5). Kept as two reasons, not
    // one exclusion set, so the mirrored SKIPPED rows say which (§18.3.1).
    const { data, error } = await supabase.from('clients').select('id, phone_e164, suppressed_at, status').eq('org_id', claimed.org_id);
    if (error) throw error;
    const clients = (data ?? []) as { id: string; phone_e164: string | null; suppressed_at: string | null; status: string }[];
    const suppressedJids = suppressedJidsOf(clients);
    // suppressedJidsOf derives jids from each client's CURRENT phone number, but a
    // recipient's jid was frozen at queue time. A client who opted out and then changed
    // or cleared their number would not match, so suppression is re-applied by client_id
    // as well — the jid set alone is not enough to keep an opt-out honoured.
    const suppressedIds = new Set(clients.filter((c) => c.suppressed_at).map((c) => c.id));
    for (const r of recipients) if (suppressedIds.has(r.client_id)) suppressedJids.add(r.jid);
    const inactiveIds = new Set(clients.filter((c) => !c.suppressed_at && c.status !== 'active').map((c) => c.id));

    const active = recipients.filter((r) => !inactiveIds.has(r.client_id));
    const inactiveSkipped: SkippedEntry[] = recipients
      .filter((r) => inactiveIds.has(r.client_id))
      .map((r) => ({ jid: r.jid, displayName: r.display_name, reason: 'INACTIVE' as const }));

    const jids = Array.from(new Set(active.map((r) => r.jid)));
    const registered = jids.length ? await deps.checkRegistered(jids) : {};
    const queue = buildQueue({
      candidates: active.map((r) => ({
        contact: { id: r.client_id, displayName: r.display_name, e164: `+${r.jid.split('@')[0]}`, jid: r.jid },
        registeredOnWhatsApp: registered[r.jid] ?? 'unknown',
        clientId: r.client_id,
      })),
      confirmedJids: new Set(jids),
      suppressedJids,
      body: claimed.body ?? undefined,
      mediaPath: claimed.media_path,
    });
    queue.skipped.push(...inactiveSkipped);

    // Skipped recipients never reach the outbox; record them so the browser sees why.
    const clientByJid = new Map(recipients.map((r) => [r.jid, r.client_id]));
    await Promise.all(
      queue.skipped
        .filter((s) => s.reason !== 'DUPLICATE')
        .map((s) =>
          mirrorMessageResult(supabase, {
            orgId: claimed.org_id,
            jid: s.jid,
            clientId: clientByJid.get(s.jid) ?? null,
            displayName: s.displayName,
            body: claimed.body ?? undefined,
            mediaPath: claimed.media_path,
            status: 'SKIPPED',
            errorReason: s.reason,
            batchId: claimed.id,
          }).catch(() => {}),
        ),
    );

    if (queue.items.length === 0) {
      await finishSendJob(supabase, userId, claimed, 'failed', 'None of the recipients can receive this message.');
      return 'failed';
    }
    await deps.sendBatch(claimed.org_id, claimed.id, queue, windowForJob(claimed));
    await finishSendJob(supabase, userId, claimed, 'done', null);
    return 'done';
  } catch (err) {
    const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
    await finishSendJob(supabase, userId, claimed, 'failed', message.slice(0, 500)).catch(() => {});
    return 'failed';
  }
}

export interface SendJobRunnerOptions extends JobRunnerDeps {
  /** Firms whose jobs this device may run (the user's current memberships). */
  getOrgIds: () => string[];
  /** Whether a batch is already running on this phone; jobs wait until it finishes. */
  isBusy: () => boolean;
  onActivity?: (job: SendJobRow | null) => void;
  pollIntervalMs?: number;
}

/** Subscribes to the user's own jobs, polls as a fallback, and runs claimable jobs one at a time. */
export class SendJobRunner {
  private current: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private offs: (() => void)[] = [];

  constructor(private readonly opts: SendJobRunnerOptions) {}

  start(): () => void {
    this.stopped = false;
    this.offs.push(
      subscribeSendJobs(this.opts.supabase, { column: 'created_by', value: this.opts.userId }, (row) => {
        if (row.status === 'queued') void this.poll();
      }),
    );
    const timer = setInterval(() => void this.poll(), this.opts.pollIntervalMs ?? 60_000);
    this.offs.push(() => clearInterval(timer));
    void this.poll();
    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.offs.forEach((off) => off());
    this.offs = [];
  }

  /** Runs every currently claimable job, sequentially. Safe to call repeatedly (e.g. on app resume). */
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = this.drain().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.again = false;
        if (this.opts.isBusy()) return;
        const orgIds = this.opts.getOrgIds();
        const jobs = await listRunnableJobs(this.opts.supabase, this.opts.userId, orgIds);
        for (const job of jobs) {
          if (this.stopped || this.opts.isBusy()) break;
          if (!orgIds.includes(job.org_id)) continue;
          this.opts.onActivity?.(job);
          try {
            await runSendJob(this.opts, job);
          } finally {
            this.opts.onActivity?.(null);
          }
        }
      } while (this.again && !this.stopped);
    } catch (err) {
      console.warn('[jobRunner] poll failed', err);
    }
  }
}
