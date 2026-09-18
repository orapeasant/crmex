import { Avatar, initialsFor } from '../../ui/Avatar.js';
import { CheckIcon } from '../../ui/icons.js';

export interface SendResultRow {
  jid: string;
  displayName: string;
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string;
}

const STATUS_BADGE: Record<SendResultRow['status'], { label: string; className: string }> = {
  QUEUED: { label: 'Waiting', className: 'badge badge--neutral' },
  SENT: { label: 'Sent', className: 'badge badge--success' },
  FAILED: { label: 'Failed', className: 'badge badge--danger' },
  SKIPPED: { label: 'Skipped', className: 'badge badge--warning' },
};

export function SendProgress({ rows, done, whatsAppReady }: { rows: SendResultRow[]; done: boolean; whatsAppReady: boolean }) {
  const sent = rows.filter((r) => r.status === 'SENT').length;
  const failed = rows.filter((r) => r.status === 'FAILED').length;

  return (
    <div className="stack">
      <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: 24 }}>
        {done ? (
          <span className="avatar" style={{ width: 56, height: 56, background: failed ? 'var(--warning)' : 'var(--success)' }}>
            <CheckIcon size={28} />
          </span>
        ) : (
          <span className="spinner" style={{ width: 40, height: 40, borderWidth: 3, color: 'var(--primary)' }} />
        )}
        <h1 className="section-title">{done ? (failed ? 'Finished with some failures' : 'Message sent') : 'Sending…'}</h1>
        <p className="muted">
          {done
            ? `${sent} of ${rows.length} delivered to WhatsApp${failed ? `, ${failed} failed` : ''}.`
            : whatsAppReady
              ? `Sent ${sent} of ${rows.length}. Messages go out one at a time — you can leave the app open or switch away.`
              : 'Waiting for WhatsApp to reconnect. Sending will resume automatically.'}
        </p>
      </div>

      <section className="card">
        {rows.map((r) => (
          <div key={r.jid} className="recipient-row">
            <Avatar initials={initialsFor(r.displayName)} size={32} variant="contact" />
            <div className="contact-row__text">
              <div className="contact-row__name">{r.displayName}</div>
              {r.error ? <div className="contact-row__phone" style={{ color: 'var(--danger)' }}>{r.error}</div> : <div className="contact-row__phone">+{r.jid.split('@')[0]}</div>}
            </div>
            <span className={STATUS_BADGE[r.status].className}>{STATUS_BADGE[r.status].label}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
