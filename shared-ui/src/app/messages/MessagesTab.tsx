import { useCallback, useState } from 'react';
import { memberLabel } from '../../crm/history.js';
import { loadBatchHistory } from '../data.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { EmptyState, ErrorCard, LoadingCard, Segmented } from '../ui/components.js';
import { ChevronRightIcon, ClockIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { formatDateTime } from '../ui/util.js';
import { JOB_STATUS } from './status.js';
import { SendWizard } from './wizard/SendWizard.js';

export function MessagesTab({ active, onWizardFocus, onLinkWhatsApp }: { active: boolean; onWizardFocus: (focus: boolean) => void; onLinkWhatsApp: () => void }) {
  const [view, setView] = useState<'new' | 'history'>('new');
  const [focus, setFocus] = useState(false);

  const reportFocus = useCallback(
    (f: boolean) => {
      setFocus(f);
      onWizardFocus(f);
    },
    [onWizardFocus],
  );

  return (
    <>
      {!focus && (
        <div className="content content--flush-bottom">
          <Segmented
            label="Messages"
            value={view}
            onChange={(v) => {
              setView(v);
              onWizardFocus(v === 'new' && focus);
            }}
            options={[
              { value: 'new', label: 'New message' },
              { value: 'history', label: 'History' },
            ]}
          />
        </div>
      )}
      <div hidden={view !== 'new'}>
        <SendWizard active={active && view === 'new'} onFocusChange={reportFocus} onLinkWhatsApp={onLinkWhatsApp} />
      </div>
      {view === 'history' && <HistoryList />}
    </>
  );
}

function HistoryList() {
  const { supabase, user } = useApp();
  const { orgId, dataVersion } = useActiveFirm();
  const nav = useNav();

  const data = useAsync(() => loadBatchHistory(supabase, orgId), [supabase, orgId, dataVersion]);

  return (
    <main className="content stack">
      {data.status === 'loading' && <LoadingCard label="Loading history…" />}
      {data.status === 'error' && <ErrorCard error={data.error} onRetry={data.reload} prefix="Couldn't load history" />}
      {data.data && data.data.entries.length === 0 && <EmptyState icon={<ClockIcon size={28} />} title="No messages yet" text="Messages sent from this firm appear here." />}
      {data.data && data.data.entries.length > 0 && (
        <>
          <div className="row row--between">
            <span className="faint">Messages sent by everyone in the firm</span>
            <button className="btn btn--ghost btn--sm" onClick={data.reload} disabled={data.refreshing}>
              {data.refreshing ? <span className="spinner" /> : 'Refresh'}
            </button>
          </div>
          <ul className="contact-list">
            {data.data.entries.map((e) => {
              const sender = e.senderId === user.id ? 'You' : memberLabel(data.data!.members.find((m) => m.user_id === e.senderId), 'Former member');
              const inFlight = e.jobStatus === 'queued' || e.jobStatus === 'claimed' || e.jobStatus === 'cancelled' || e.jobStatus === 'failed';
              return (
                <li key={e.id} className="contact-row" onClick={() => nav.push({ name: 'batch', batchId: e.id })}>
                  <div className="contact-row__text">
                    <div className="contact-row__name">{e.body?.trim() || (e.hasMedia ? 'Image' : 'Message')}</div>
                    <div className="contact-row__phone">
                      {formatDateTime(e.when)} · {sender} · {e.total} {e.total === 1 ? 'recipient' : 'recipients'}
                    </div>
                  </div>
                  {inFlight && e.jobStatus ? (
                    <span className={JOB_STATUS[e.jobStatus].className}>{JOB_STATUS[e.jobStatus].label}</span>
                  ) : (
                    <span className={e.failed ? 'badge badge--danger' : 'badge badge--success'}>
                      {e.sent}/{e.total} sent
                    </span>
                  )}
                  <ChevronRightIcon size={18} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
