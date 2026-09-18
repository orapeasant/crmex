import { CardIcon } from '../ui/icons.js';

export function BillingPage() {
  return (
    <main className="content stack">
      <section className="card stack">
        <div className="row row--between">
          <div>
            <div className="card__subtitle">Current plan</div>
            <div className="section-title" style={{ fontSize: 22 }}>
              Free
            </div>
          </div>
          <span className="badge badge--success">Active</span>
        </div>
        <p className="muted">Includes AI message drafting, image generation within the daily limit, and WhatsApp sending from your linked account.</p>
      </section>

      <section className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: 24 }}>
        <span style={{ color: 'var(--text-faint)' }}>
          <CardIcon size={32} />
        </span>
        <div>
          <div className="card__title">No payment method needed</div>
          <div className="card__subtitle">Paid plans aren't available yet. You won't be charged.</div>
        </div>
      </section>
    </main>
  );
}
