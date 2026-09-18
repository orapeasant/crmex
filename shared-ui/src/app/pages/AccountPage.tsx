import { useApp } from '../context.js';
import { Avatar } from '../ui/Avatar.js';

export function AccountPage({ onSignOut }: { onSignOut: () => void }) {
  const { user, profile } = useApp();
  const provider = (user.app_metadata?.provider as string | undefined) ?? 'email';
  const memberSince = user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

  return (
    <main className="content stack">
      <section className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: 24 }}>
        <Avatar initials={profile.initials} size={72} />
        <div>
          <h1 className="section-title">{profile.fullName}</h1>
          <p className="muted">{profile.email}</p>
        </div>
      </section>

      <section className="card list-card">
        <div className="list-item">
          <span className="muted">Name</span>
          <span>{profile.fullName}</span>
        </div>
        <div className="list-item">
          <span className="muted">Email</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile.email}</span>
        </div>
        <div className="list-item">
          <span className="muted">Signed in with</span>
          <span style={{ textTransform: 'capitalize' }}>{provider}</span>
        </div>
        <div className="list-item">
          <span className="muted">Member since</span>
          <span>{memberSince}</span>
        </div>
      </section>

      <p className="faint">Your name and email come from your Google account. Change them there.</p>

      <button className="btn btn--secondary btn--block" style={{ color: 'var(--danger)' }} onClick={onSignOut}>
        Log out
      </button>
    </main>
  );
}
