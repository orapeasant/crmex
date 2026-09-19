import { useEffect, useMemo, useState } from 'react';
import { memberLabel } from '../../crm/history.js';
import { listMessageHistory, listOrgMemberRows } from '../../supabase/crmRepo.js';
import { cancelSendJob, getSendJob, subscribeSendJobs } from '../../supabase/sendJobs.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { Avatar, initialsFor } from '../ui/Avatar.js';
import { ErrorCard, LoadingCard, ScreenHeader } from '../ui/components.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError, formatDateTime } from '../ui/util.js';
import { JOB_STATUS, SKIP_REASON_LABELS, STATUS_BADGE } from './status.js';
import { formatJobSchedule, isCampaignJob } from './wizard/schedule.js';

const FINISHED = new Set(['done', 'cancelled', 'failed', 'expired']);

export function BatchDetail({ batchId }: { batchId: string }) {
  const nav = useNav();
  return (
    <>
      <ScreenHeader title="Message details" onBack={nav.pop} />
      <main className="content stack">
        <BatchStatus batchId={batchId} />
      </main>
    </>
  );
}

/**
 * Per-recipient status of one batch. For a batch queued from a browser
 * (a send_jobs row with this id) it follows the job live: Realtime updates
 * on the job plus polling message_history while the phone works through it.
 */
export function BatchStatus({ batchId }: { batchId: string }) {
  const { supabase, user } = useApp();
  const { orgId } = useActiveFirm();
  const [tick, setTick] = useState(0);

  const data = useAsync(async () => {
    const [job, rows, members] = await Promise.all([getSendJob(supabase, orgId, batchId).catch(() => null), listMessageHistory(supabase, orgId, { batchId }), listOrgMemberRows(supabase, orgId).catch(() => [])]);
    return { job, rows, members };
  }, [supabase, orgId, batchId, tick]);

  const job = data.data?.job ?? null;
  const live = job !== null && !FINISHED.has(job.status);

  useEffect(() => {
    if (!live) return;
    const off = subscribeSendJobs(supabase, { column: 'id', value: batchId }, () => setTick((t) => t + 1));
    const timer = setInterval(() => setTick((t) => t + 1), 4000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [live, supabase, batchId]);

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const recipients = useMemo(() => {
    const rows = data.data?.rows ?? [];
    const byJid = new Map(rows.map((r) => [r.jid, r]));
    const list = rows.map((r) => ({ key: `${r.id}`, name: r.display_name || `+${r.jid.split('@')[0]}`, sub: r.error_reason ? SKIP_REASON_LABELS[r.error_reason] ?? r.error_reason : `+${r.jid.split('@')[0]}`, status: r.status as keyof typeof STATUS_BADGE }));
    for (const r of job?.recipients ?? []) {
      if (!byJid.has(r.jid)) list.push({ key: r.jid, name: r.display_name, sub: `+${r.jid.split('@')[0]}`, status: 'QUEUED' });
    }
    return list;
  }, [data.data, job]);

  if (data.status === 'loading') return <LoadingCard />;
  if (data.status === 'error') return <ErrorCard error={data.error} onRetry={data.reload} />;
  if (!data.data) return null;

  const { rows, members } = data.data;
  const first = rows[rows.length - 1];
  const body = job?.body ?? first?.body ?? null;
  const media = job?.media_path ?? first?.media_path ?? null;
  const senderId = job?.created_by ?? first?.user_id ?? null;
  const sender = senderId === user.id ? 'You' : memberLabel(members.find((m) => m.user_id === senderId), 'Former member');
  const when = job?.created_at ?? first?.created_at ?? null;
  const sent = rows.filter((r) => r.status === 'SENT').length;
  const failed = rows.filter((r) => r.status === 'FAILED').length;

  if (!job && rows.length === 0) return <div className="card muted">No record of this message in the firm's history.</div>;

  return (
    <>
      <section className="card stack">
        <div className="row row--between">
          <div>
            <div className="card__title">{sender}</div>
            <div className="faint">{formatDateTime(when)}</div>
          </div>
          {job ? <span className={JOB_STATUS[job.status].className}>{JOB_STATUS[job.status].label}</span> : <span className="badge badge--neutral">Sent from phone</span>}
        </div>
        {(body || media) && (
          <div className="bubble-wrap">
            <div className="bubble">
              {media && <div className="bubble__media">Image attached</div>}
              {body && <div className="bubble__text">{body}</div>}
            </div>
          </div>
        )}
        <div className="row row--wrap">
          <span className="badge badge--success">{sent} sent</span>
          {failed > 0 && <span className="badge badge--danger">{failed} failed</span>}
          <span className="badge badge--neutral">{recipients.length} {recipients.length === 1 ? "recipient" : "recipients"}</span>
        </div>
        {/* Schedule and pace (crmex.md §18.6): shown only for a campaign — a job with any of the three §18.3.2 columns set. */}
        {job && isCampaignJob(job) && <div className="faint">{formatJobSchedule(job)}</div>}
        {job?.status === 'queued' && (
          <div className="alert alert--info">
            Waiting for your phone. It sends this message when CRMEX is open on it with WhatsApp linked and an internet connection — it must stay online for the whole run.
          </div>
        )}
        {job?.status === 'claimed' && <div className="alert alert--info">Your phone is sending this message now, one recipient at a time. It can't be cancelled from here while it's running.</div>}
        {job?.status === 'expired' && <div className="alert alert--warning">This ran past its late window before your phone picked it up, so it was never sent.</div>}
        {job?.status === 'failed' && job.error && <div className="alert alert--error">{job.error}</div>}
        {job?.status === 'queued' && job.created_by === user.id && (
          <button
            className="btn btn--secondary"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              setCancelError(null);
              try {
                await cancelSendJob(supabase, orgId, user.id, job.id);
                setTick((t) => t + 1);
              } catch (err) {
                setCancelError(describeError(err));
              } finally {
                setCancelling(false);
              }
            }}
          >
            {cancelling ? <span className="spinner" /> : 'Cancel message'}
          </button>
        )}
        {cancelError && <div className="alert alert--error">{cancelError}</div>}
      </section>

      <section className="card">
        {recipients.map((r) => (
          <div key={r.key} className="recipient-row">
            <Avatar initials={initialsFor(r.name)} size={32} variant="contact" />
            <div className="contact-row__text">
              <div className="contact-row__name">{r.name}</div>
              <div className="contact-row__phone">{r.sub}</div>
            </div>
            <span className={STATUS_BADGE[r.status].className}>{job?.status === 'cancelled' && r.status === 'QUEUED' ? 'Not sent' : STATUS_BADGE[r.status].label}</span>
          </div>
        ))}
      </section>
    </>
  );
}
