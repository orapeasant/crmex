// The signed-in user's own activity in the active firm (message_history and
// image_sessions are firm-readable under RLS, so both org and user are filtered),
// counted server-side with head-only queries.
import { useEffect, useState } from 'react';
import { useApp, useActiveFirm } from '../context.js';
import { loadUsageStats, type UsageStats } from '../data.js';
import { describeError } from '../ui/util.js';

export function UsagePage() {
  const { supabase, user } = useApp();
  const { orgId, activeOrg } = useActiveFirm();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadUsageStats(supabase, orgId, user.id)
      .then(setStats)
      .catch((err) => setError(describeError(err)));
  }, [supabase, orgId, user.id]);

  const value = (n: number | undefined) => (stats ? n : '—');

  return (
    <main className="content stack">
      <p className="muted">Your own activity in {activeOrg.name}.</p>

      {error && <div className="alert alert--error">Couldn't load usage: {error}</div>}

      <div className="stat-grid">
        <div className="stat">
          <div className="stat__value">{value(stats?.sentToday)}</div>
          <div className="stat__label">Messages sent today</div>
        </div>
        <div className="stat">
          <div className="stat__value">{value(stats?.sent30d)}</div>
          <div className="stat__label">Sent, last 30 days</div>
        </div>
        <div className="stat">
          <div className="stat__value">{value(stats?.failed30d)}</div>
          <div className="stat__label">Failed, last 30 days</div>
        </div>
        <div className="stat">
          <div className="stat__value">{value(stats?.images30d)}</div>
          <div className="stat__label">Images, last 30 days</div>
        </div>
      </div>

      <p className="faint">Image generation has a daily limit set by the service. Messages are sent from your own WhatsApp account.</p>
    </main>
  );
}
