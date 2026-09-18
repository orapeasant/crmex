import type { BuiltQueue } from '../../../send/queueBuilder.js';
import { MAX_BATCH_RECIPIENTS } from '../../../supabase/sendJobs.js';
import { Avatar, initialsFor } from '../../ui/Avatar.js';
import { SKIP_REASON_LABELS } from '../status.js';
import type { GeneratedImage } from './types.js';

export type ReviewCheck = { status: 'checking' } | { status: 'ready'; queue: BuiltQueue } | { status: 'error'; error: string };


export interface ReviewStepProps {
  text: string;
  image: GeneratedImage | null;
  selectedCount: number;
  check: ReviewCheck;
  onRetry: () => void;
  /** 'queue': this device can't check WhatsApp; the user's phone checks when it sends. */
  mode: 'direct' | 'queue';
}

export function ReviewStep({ text, image, selectedCount, check, onRetry, mode }: ReviewStepProps) {
  const sendable = check.status === 'ready' ? check.queue.items : [];
  const skipped = check.status === 'ready' ? check.queue.skipped : [];

  return (
    <div className="stack">
      <div>
        <h1 className="section-title">Review and send</h1>
        <p className="section-subtitle">Check the message and recipients before sending.</p>
      </div>

      <section className="card stack">
        <div className="card__title">Message</div>
        <div className="bubble-wrap">
          <div className="bubble">
            {image && <img src={image.previewUrl} alt="Image attached to the message" />}
            {text.trim() && <div className="bubble__text">{text.trim()}</div>}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="row row--between" style={{ marginBottom: 4 }}>
          <div className="card__title">Recipients</div>
          {check.status === 'ready' && (
            <span className="badge badge--neutral">
              {sendable.length} of {selectedCount} will receive it
            </span>
          )}
        </div>

        {check.status === 'checking' && (
          <div className="row muted" style={{ padding: '12px 0' }}>
            <span className="spinner" /> Checking {selectedCount} recipient{selectedCount === 1 ? '' : 's'}{mode === 'direct' ? ' on WhatsApp' : ''}…
          </div>
        )}

        {check.status === 'error' && (
          <div className="alert alert--error stack" style={{ marginTop: 8 }}>
            <span>Couldn't check recipients: {check.error}</span>
            <button className="btn btn--secondary btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
              Try again
            </button>
          </div>
        )}

        {check.status === 'ready' && (
          <div>
            {sendable.map((r) => (
              <div key={r.jid} className="recipient-row">
                <Avatar initials={initialsFor(r.displayName)} size={32} variant="contact" />
                <div className="contact-row__text">
                  <div className="contact-row__name">{r.displayName}</div>
                  <div className="contact-row__phone">+{r.jid.split('@')[0]}</div>
                </div>
                {mode === 'direct' ? <span className="badge badge--success">On WhatsApp</span> : <span className="badge badge--neutral">Ready</span>}
              </div>
            ))}
            {skipped.map((s) => (
              <div key={`${s.jid}:${s.reason}`} className="recipient-row" style={{ opacity: 0.7 }}>
                <Avatar initials={initialsFor(s.displayName)} size={32} variant="contact" />
                <div className="contact-row__text">
                  <div className="contact-row__name">{s.displayName}</div>
                  <div className="contact-row__phone">+{s.jid.split('@')[0]}</div>
                </div>
                <span className={s.reason === 'DUPLICATE' ? 'badge badge--neutral' : 'badge badge--warning'}>{SKIP_REASON_LABELS[s.reason]}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {mode === 'queue' && check.status === 'ready' && sendable.length > 0 && (
        <div className="alert alert--info">Your phone sends this message: it needs Leagentex open with WhatsApp linked and an internet connection. It re-checks opt-outs and WhatsApp registration before sending.</div>
      )}

      {check.status === 'ready' && sendable.length > MAX_BATCH_RECIPIENTS && (
        <div className="alert alert--error">One message can go to at most {MAX_BATCH_RECIPIENTS} recipients. Go back and select fewer.</div>
      )}

      {check.status === 'ready' && sendable.length === 0 && (
        <div className="alert alert--warning">None of the selected clients can receive this message. Go back and choose different recipients.</div>
      )}
    </div>
  );
}
