// Compose -> Recipients -> Review. Every rule deciding what may be sent lives
// outside this component (clientRecipients, buildQueue, DirectSender,
// queueSendJob, the phone's job runner); this gathers inputs and requires
// two distinct actions to send (Send, then "Send now" — SAF-04).
//
// Send modes (crmex.md §15.10):
//  * direct (a device holding WhatsApp): durable outbox -> Node, from here.
//  * queue (browser): inserts a send_job that the user's own phone runs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientRecipients } from '../../../crm/clients.js';
import { listClients } from '../../../supabase/crmRepo.js';
import { MAX_BATCH_RECIPIENTS, queueSendJob, type ExcludedClient } from '../../../supabase/sendJobs.js';
import { useActiveFirm, useApp } from '../../context.js';
import { buildReviewQueue } from '../../data.js';
import { Sheet } from '../../ui/components.js';
import { BackIcon, SendIcon } from '../../ui/icons.js';
import { useAsync } from '../../ui/useAsync.js';
import { describeError, useBackButton } from '../../ui/util.js';
import { useMessaging } from '../MessagingProvider.js';
import { BatchStatus } from '../BatchDetail.js';
import { ComposeStep } from './ComposeStep.js';
import { summarizeExcluded } from './excluded.js';
import { RecipientsStep, type ContactsState } from './RecipientsStep.js';
import { ReviewStep, type ReviewCheck } from './ReviewStep.js';
import { defaultCampaignPlan, expiresAtIso, formatScheduleSummary, scheduledAtIso, type CampaignPlan } from './schedule.js';
import { ScheduleStep } from './ScheduleStep.js';
import { SendProgress, type SendResultRow } from './SendProgress.js';
import { Stepper } from './Stepper.js';
import { EMPTY_DRAFT, draftImage, isDraftComplete, type MessageDraft } from './types.js';

const DIRECT_STEPS = ['Message', 'Recipients', 'Review'];
// A queued (browser) send goes through the schedule-and-pace step (crmex.md §18.4 step 5);
// a direct send happens synchronously right here, so there is no "later" to schedule.
const QUEUE_STEPS = ['Message', 'Recipients', 'Review', 'Schedule'];

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending' | 'done'; rows: SendResultRow[] }
  | { phase: 'queued'; jobId: string; excluded: ExcludedClient[] }
  | { phase: 'error'; error: string };

export interface SendWizardProps {
  /** Only the visible wizard reacts to the hardware back button. */
  active: boolean;
  /** True while the wizard wants the whole screen (review, sending). */
  onFocusChange: (focus: boolean) => void;
  onLinkWhatsApp: () => void;
}

export function SendWizard({ active, onFocusChange, onLinkWhatsApp }: SendWizardProps) {
  const { api, supabase, user } = useApp();
  const { orgId, dataVersion, bump } = useActiveFirm();
  const messaging = useMessaging();
  const direct = messaging.mode === 'direct';
  const waState = messaging.whatsApp?.state ?? null;
  const whatsAppReady = !direct || waState === 'ready';
  const needsLink = direct && (waState === 'qr' || waState === 'logged-out');

  const STEPS = direct ? DIRECT_STEPS : QUEUE_STEPS;
  const SCHEDULE_STEP = STEPS.length - 1; // only meaningful when !direct

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MessageDraft>(EMPTY_DRAFT);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [check, setCheck] = useState<ReviewCheck>({ status: 'checking' });
  const [plan, setPlan] = useState<CampaignPlan>(defaultCampaignPlan());
  const [confirming, setConfirming] = useState(false);
  const [sendState, setSendState] = useState<SendState>({ phase: 'idle' });

  const clients = useAsync(() => (step >= 1 ? listClients(supabase, orgId) : Promise.resolve(null)), [supabase, orgId, dataVersion, step >= 1]);
  const recipients = useMemo(() => (clients.data ? clientRecipients(clients.data) : null), [clients.data]);
  const contactsState: ContactsState = {
    status: clients.status === 'error' ? 'error' : recipients ? 'ready' : 'loading',
    contacts: recipients?.recipients ?? [],
    suppressedCount: recipients?.suppressedCount ?? 0,
    noPhoneCount: recipients?.noPhoneCount ?? 0,
    inactiveCount: recipients?.inactiveCount ?? 0,
    error: clients.error ?? undefined,
  };
  const selected = contactsState.contacts.filter((c) => selectedIds.has(c.id));

  useEffect(() => {
    onFocusChange(step >= 2 || sendState.phase !== 'idle');
  }, [step, sendState.phase, onFocusChange]);

  const runCheck = useCallback(async () => {
    setCheck({ status: 'checking' });
    try {
      const queue = await buildReviewQueue({ supabase, orgId, selected, body: draft.text, mediaPath: draftImage(draft)?.path ?? null, checkRegistered: messaging.checkRegistered });
      setCheck({ status: 'ready', queue });
    } catch (err) {
      setCheck({ status: 'error', error: describeError(err) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, orgId, selectedIds, contactsState.contacts, draft, messaging.checkRegistered]);

  useEffect(() => {
    if (step === 2 && whatsAppReady) void runCheck();
    // Re-check only when entering review or when WhatsApp comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, whatsAppReady]);

  function goTo(next: number) {
    setConfirming(false);
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  function startOver() {
    setSendState({ phase: 'idle' });
    setDraft(EMPTY_DRAFT);
    setSelectedIds(new Set());
    setPlan(defaultCampaignPlan());
    goTo(0);
  }

  useBackButton(() => {
    if (!active) return false;
    if (confirming) {
      setConfirming(false);
      return true;
    }
    if (sendState.phase === 'sending') return false;
    if (sendState.phase !== 'idle') {
      startOver();
      return true;
    }
    if (step > 0) {
      goTo(step - 1);
      return true;
    }
    return false;
  });

  async function send() {
    if (check.status !== 'ready') return;
    const queue = check.queue;
    setConfirming(false);
    if (!direct) {
      try {
        const { job, excluded } = await queueSendJob(supabase, {
          orgId,
          userId: user.id,
          body: queue.items[0]?.body ?? null,
          mediaPath: queue.items[0]?.mediaPath ?? null,
          clientIds: queue.items.map((i) => i.clientId).filter((id): id is string => Boolean(id)),
          // crmex.md §18.3.2: "send now" is scheduledAt: null, exactly the pre-§18 behaviour.
          scheduledAt: scheduledAtIso(plan),
          intervalMs: plan.intervalMs,
          jitterPct: plan.jitterPct,
          expiresAt: expiresAtIso(plan),
        });
        bump();
        setSendState({ phase: 'queued', jobId: job.id, excluded });
      } catch (err) {
        setSendState({ phase: 'error', error: describeError(err) });
      }
      return;
    }
    if (!messaging.sender) return;
    let rows: SendResultRow[] = queue.items.map((i) => ({ jid: i.jid, displayName: i.displayName, status: 'QUEUED' }));
    setSendState({ phase: 'sending', rows });
    try {
      await messaging.sender.send(orgId, crypto.randomUUID(), queue, (e) => {
        if (e.type === 'result') {
          rows = rows.map((r, idx) => (idx === e.index ? { ...r, status: e.result.status, error: e.result.error } : r));
          setSendState((s) => (s.phase === 'sending' || s.phase === 'done' ? { ...s, rows } : s));
        } else if (e.type === 'done') {
          setSendState({ phase: 'done', rows });
          bump();
        }
      });
    } catch (err) {
      setSendState({ phase: 'error', error: describeError(err) });
    }
  }

  if (sendState.phase === 'queued') {
    const excludedPhrases = summarizeExcluded(sendState.excluded);
    return (
      <>
        <main className="content content--with-actionbar stack">
          <div>
            <h1 className="section-title">Message queued</h1>
            <p className="section-subtitle">Your phone will send it. You can close this page; progress also appears under History.</p>
          </div>
          {excludedPhrases.length > 0 && (
            <div className="alert alert--warning">
              {/* Named separately, never merged (§18.3.1): a user who sees one number assumes the wrong reason. */}
              Not sent to {excludedPhrases.join(' · ')}.
            </div>
          )}
          <BatchStatus batchId={sendState.jobId} />
        </main>
        <div className="actionbar">
          <div className="actionbar__inner">
            <button className="btn btn--primary btn--block" onClick={startOver}>
              New message
            </button>
          </div>
        </div>
      </>
    );
  }

  if (sendState.phase === 'sending' || sendState.phase === 'done') {
    return (
      <>
        <main className="content content--with-actionbar">
          <SendProgress rows={sendState.rows} done={sendState.phase === 'done'} whatsAppReady={waState === 'ready'} />
        </main>
        {sendState.phase === 'done' && (
          <div className="actionbar">
            <div className="actionbar__inner">
              <button className="btn btn--primary btn--block" onClick={startOver}>
                New message
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  const sendableCount = check.status === 'ready' ? check.queue.items.length : 0;
  const tooMany = sendableCount > MAX_BATCH_RECIPIENTS;
  const busyElsewhere = direct && messaging.busy;

  return (
    <>
      <main className="content content--with-actionbar">
        <Stepper steps={STEPS} current={step} />

        {needsLink && (
          <div className="alert alert--warning row row--between" style={{ marginBottom: 16 }}>
            <span>WhatsApp isn't linked yet.</span>
            <button className="btn btn--secondary btn--sm" onClick={onLinkWhatsApp}>
              Link now
            </button>
          </div>
        )}

        {sendState.phase === 'error' && (
          <div className="alert alert--error" style={{ marginBottom: 16 }}>
            Couldn't send: {sendState.error}
          </div>
        )}

        {step === 0 && <ComposeStep api={api} draft={draft} onChange={setDraft} />}
        {step === 1 && <RecipientsStep contactsState={contactsState} selectedIds={selectedIds} onChange={setSelectedIds} onRetry={clients.reload} />}
        {step === 2 && (
          <ReviewStep
            mode={messaging.mode}
            text={draft.text}
            image={draftImage(draft)}
            selectedCount={selected.length}
            check={whatsAppReady ? check : needsLink ? { status: 'error', error: 'WhatsApp is not linked' } : { status: 'checking' }}
            onRetry={runCheck}
          />
        )}
        {step === 2 && busyElsewhere && <div className="alert alert--info" style={{ marginTop: 16 }}>Another message is being sent from this phone. You can send once it finishes.</div>}
        {!direct && step === SCHEDULE_STEP && <ScheduleStep plan={plan} onChange={setPlan} recipientCount={sendableCount} />}
      </main>

      <div className="actionbar">
        <div className="actionbar__inner">
          {step === 0 && (
            <button className="btn btn--primary" disabled={!isDraftComplete(draft)} onClick={() => goTo(1)}>
              Next: Recipients
            </button>
          )}
          {step === 1 && (
            <>
              <button className="btn btn--secondary" onClick={() => goTo(0)}>
                <BackIcon size={18} /> Back
              </button>
              <button className="btn btn--primary" disabled={selectedIds.size === 0} onClick={() => goTo(2)}>
                Review ({selected.length})
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button className="btn btn--secondary" onClick={() => goTo(1)}>
                <BackIcon size={18} /> Recipients
              </button>
              <button className="btn btn--secondary" onClick={() => goTo(0)}>
                Edit text
              </button>
              {direct ? (
                <button className="btn btn--primary" disabled={!whatsAppReady || sendableCount === 0 || tooMany || busyElsewhere} onClick={() => setConfirming(true)}>
                  <SendIcon size={18} /> Send
                </button>
              ) : (
                <button className="btn btn--primary" disabled={sendableCount === 0 || tooMany} onClick={() => goTo(SCHEDULE_STEP)}>
                  Next: Schedule
                </button>
              )}
            </>
          )}
          {!direct && step === SCHEDULE_STEP && (
            <>
              <button className="btn btn--secondary" onClick={() => goTo(2)}>
                <BackIcon size={18} /> Review
              </button>
              <button className="btn btn--primary" disabled={sendableCount === 0 || tooMany} onClick={() => setConfirming(true)}>
                <SendIcon size={18} /> {plan.timing.mode === 'now' ? 'Queue for my phone' : 'Schedule'}
              </button>
            </>
          )}
        </div>
      </div>

      <Sheet open={confirming && check.status === 'ready'} onClose={() => setConfirming(false)} labelledBy="confirm-title">
        <div>
          <h2 id="confirm-title" className="section-title">
            Send to {sendableCount} {sendableCount === 1 ? 'person' : 'people'}?
          </h2>
          <p className="section-subtitle">
            {direct
              ? "Messages can't be unsent once they're delivered."
              : `${formatScheduleSummary(plan, sendableCount)}. Your phone will send it from your WhatsApp account — it must be online with CRMEX open for the whole run. You can cancel until your phone picks it up.`}
          </p>
        </div>
        <div className="row">
          <button className="btn btn--secondary" style={{ flex: 1 }} onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button className="btn btn--primary" style={{ flex: 1 }} onClick={() => void send()}>
            {direct ? 'Send now' : plan.timing.mode === 'now' ? 'Queue for my phone' : 'Schedule it'}
          </button>
        </div>
      </Sheet>
    </>
  );
}
