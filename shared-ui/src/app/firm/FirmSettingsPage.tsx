import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { CreatedInvitation, OrgInvitation, OrgMember, OrgRole } from '../../types.js';
import { useActiveFirm, useApp } from '../context.js';
import { Avatar, initialsFor } from '../ui/Avatar.js';
import { ConfirmSheet, ErrorCard, LoadingCard, SectionLabel, Sheet } from '../ui/components.js';
import { LinkIcon, MailIcon, ShareIcon, TrashIcon, UserPlusIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError, formatDate } from '../ui/util.js';

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** Share a link through the platform share sheet, the Web Share API, or the clipboard. Returns what happened. */
export async function shareLink(share: ((d: { title?: string; text?: string; url?: string }) => Promise<void>) | undefined, data: { title: string; text: string; url: string }): Promise<'shared' | 'copied'> {
  if (share) {
    await share(data);
    return 'shared';
  }
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    await nav.share(data);
    return 'shared';
  }
  await navigator.clipboard.writeText(data.url);
  return 'copied';
}

export function FirmSettingsPage() {
  const { api, user } = useApp();
  const firm = useActiveFirm();
  const { orgId, role, canManage } = firm;

  const members = useAsync(() => api.listMembers(orgId), [api, orgId]);
  const invitations = useAsync(() => (canManage ? api.listInvitations(orgId) : Promise.resolve([] as OrgInvitation[])), [api, orgId, canManage]);

  const [roleTarget, setRoleTarget] = useState<OrgMember | null>(null);
  const [removeTarget, setRemoveTarget] = useState<OrgMember | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OrgInvitation | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function canRemove(m: OrgMember): boolean {
    if (m.userId === user.id) return true; // leave
    if (role === 'owner') return true;
    return role === 'admin' && m.role === 'member';
  }

  async function run(action: () => Promise<void>, done: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      done();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const leaving = removeTarget?.userId === user.id;

  return (
    <main className="content stack">
      <section className="card stack" style={{ gap: 4 }}>
        <div className="card__subtitle">Firm</div>
        <div className="section-title">{firm.activeOrg.name}</div>
        <div className="row" style={{ marginTop: 4 }}>
          <span className="badge badge--neutral">Your role: {ROLE_LABEL[role]}</span>
          <span className="badge badge--neutral">Plan: {firm.activeOrg.plan}</span>
        </div>
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <SectionLabel
          action={
            canManage && (
              <button className="btn btn--ghost btn--sm" onClick={() => setInviting(true)}>
                <UserPlusIcon size={16} /> Invite
              </button>
            )
          }
        >
          Members
        </SectionLabel>
        {members.status === 'loading' && <LoadingCard label="Loading members…" />}
        {members.status === 'error' && <ErrorCard error={members.error} onRetry={members.reload} prefix="Couldn't load members" />}
        {members.data && (
          <div className="card list-card">
            {members.data.map((m) => {
              const name = m.displayName || m.email || 'Member';
              return (
                <div key={m.userId} className="list-item">
                  <div className="row" style={{ minWidth: 0, flex: 1 }}>
                    <Avatar initials={initialsFor(name)} size={36} variant="contact" />
                    <div style={{ minWidth: 0 }}>
                      <div className="contact-row__name">
                        {name}
                        {m.userId === user.id && <span className="faint"> (you)</span>}
                      </div>
                      <div className="contact-row__phone">{m.email ?? '—'}</div>
                    </div>
                  </div>
                  {role === 'owner' ? (
                    <button className="badge badge--neutral badge--button" onClick={() => setRoleTarget(m)} aria-label={`Change role of ${name}`}>
                      {ROLE_LABEL[m.role]} ▾
                    </button>
                  ) : (
                    <span className="badge badge--neutral">{ROLE_LABEL[m.role]}</span>
                  )}
                  {canRemove(m) && (
                    <button className="icon-btn" aria-label={m.userId === user.id ? 'Leave firm' : `Remove ${name}`} onClick={() => setRemoveTarget(m)}>
                      <TrashIcon size={18} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!canManage && <p className="faint">Only owners and admins can invite or remove members.</p>}
      </section>

      {canManage && (
        <section className="stack" style={{ gap: 8 }}>
          <SectionLabel>Pending invitations</SectionLabel>
          {invitations.status === 'loading' && <LoadingCard label="Loading invitations…" />}
          {invitations.status === 'error' && <ErrorCard error={invitations.error} onRetry={invitations.reload} prefix="Couldn't load invitations" />}
          {invitations.data && invitations.data.length === 0 && <div className="card muted">No pending invitations.</div>}
          {invitations.data && invitations.data.length > 0 && (
            <div className="card list-card">
              {invitations.data.map((inv) => (
                <div key={inv.id} className="list-item">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="contact-row__name">{inv.email ?? 'Link / QR invitation'}</div>
                    <div className="contact-row__phone">
                      {ROLE_LABEL[inv.role]} · expires {formatDate(inv.expiresAt)}
                    </div>
                  </div>
                  <button className="btn btn--ghost btn--sm" onClick={() => setRevokeTarget(inv)}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <Sheet open={roleTarget !== null} onClose={() => !busy && (setRoleTarget(null), setActionError(null))} title={`Role for ${roleTarget?.displayName || roleTarget?.email || 'member'}`}>
        <div className="card list-card">
          {(['owner', 'admin', 'member'] as OrgRole[]).map((r) => (
            <button
              key={r}
              className="list-item list-item--button"
              disabled={busy}
              onClick={() =>
                roleTarget &&
                run(
                  async () => {
                    if (r !== roleTarget.role) await api.changeMemberRole(orgId, roleTarget.userId, r);
                    members.reload();
                    if (roleTarget.userId === user.id) await firm.refresh();
                  },
                  () => setRoleTarget(null),
                )
              }
            >
              <div>
                <div>{ROLE_LABEL[r]}</div>
                <div className="faint">{r === 'owner' ? 'Billing, firm deletion, manages admins' : r === 'admin' ? 'Invites and removes members' : 'Works with clients, matters and tasks'}</div>
              </div>
              {roleTarget?.role === r && <span className="badge badge--success">Current</span>}
            </button>
          ))}
        </div>
        {actionError && <div className="alert alert--error">{actionError}</div>}
      </Sheet>

      <ConfirmSheet
        open={removeTarget !== null}
        title={leaving ? `Leave ${firm.activeOrg.name}?` : `Remove ${removeTarget?.displayName || removeTarget?.email || 'member'}?`}
        message={leaving ? "You'll lose access to this firm's clients, matters, tasks and messages. You'll need a new invitation to rejoin." : 'They lose access to this firm immediately. Records they created stay with the firm.'}
        confirmLabel={leaving ? 'Leave firm' : 'Remove'}
        danger
        busy={busy}
        error={actionError}
        onCancel={() => (setRemoveTarget(null), setActionError(null))}
        onConfirm={() =>
          removeTarget &&
          run(
            async () => {
              await api.removeMember(orgId, removeTarget.userId);
              if (leaving) await firm.refresh();
              else members.reload();
            },
            () => setRemoveTarget(null),
          )
        }
      />

      <ConfirmSheet
        open={revokeTarget !== null}
        title="Revoke invitation?"
        message="The code or link stops working immediately."
        confirmLabel="Revoke"
        danger
        busy={busy}
        error={actionError}
        onCancel={() => (setRevokeTarget(null), setActionError(null))}
        onConfirm={() =>
          revokeTarget &&
          run(
            async () => {
              await api.revokeInvitation(orgId, revokeTarget.id);
              invitations.reload();
            },
            () => setRevokeTarget(null),
          )
        }
      />

      <InviteSheet
        open={inviting}
        canInviteAdmin={role === 'owner' || role === 'admin'}
        onClose={() => {
          setInviting(false);
          invitations.reload();
        }}
      />
    </main>
  );
}

function InviteSheet({ open, onClose, canInviteAdmin }: { open: boolean; onClose: () => void; canInviteAdmin: boolean }) {
  const { api, platform, openUrl } = useApp();
  const { orgId, activeOrg } = useActiveFirm();
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCreated(null);
      setQr(null);
      setEmail('');
      setRole('member');
      setError(null);
      setNotice(null);
    }
  }, [open]);

  useEffect(() => {
    if (!created) return;
    let cancelled = false;
    QRCode.toDataURL(created.inviteUrl, { margin: 1, width: 560, errorCorrectionLevel: 'M' })
      .then((url) => !cancelled && setQr(url))
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [created]);

  const trimmedEmail = email.trim();
  const emailValid = trimmedEmail === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setCreated(await api.createInvitation(orgId, { role, ...(trimmedEmail ? { email: trimmedEmail } : {}) }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const message = created ? `You're invited to join ${activeOrg.name} on Leagentex. Open this link on your phone with Leagentex installed (or paste it into the app's "Join a firm" screen):\n\n${created.inviteUrl}\n\nThe invitation can be used once and expires in 7 days.` : '';

  async function share() {
    if (!created) return;
    setNotice(null);
    try {
      const how = await shareLink(platform.share, { title: `Join ${activeOrg.name} on Leagentex`, text: message, url: created.inviteUrl });
      if (how === 'copied') setNotice('Link copied to the clipboard.');
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') setError(describeError(err));
    }
  }

  function emailInvite() {
    if (!created) return;
    const to = created.invitation.email ?? '';
    openUrl(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(`Join ${activeOrg.name} on Leagentex`)}&body=${encodeURIComponent(message)}`);
  }

  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title={created ? 'Invitation ready' : 'Invite a colleague'}>
      {!created ? (
        <>
          <div className="field">
            <span className="field__label">Role</span>
            <div className="segmented" role="radiogroup" aria-label="Role">
              {(['member', 'admin'] as const).map((r) => (
                <button key={r} role="radio" aria-checked={role === r} disabled={r === 'admin' && !canInviteAdmin} className={role === r ? 'segmented__item segmented__item--active' : 'segmented__item'} onClick={() => setRole(r)}>
                  {r === 'member' ? 'Member' : 'Admin'}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span className="field__label">Email (optional)</span>
            <input className="input" type="email" inputMode="email" autoCapitalize="off" placeholder="colleague@firm.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className="faint">If set, only an account with this verified email can accept.</span>
          </label>
          {error && <div className="alert alert--error">{error}</div>}
          <button className="btn btn--primary btn--block" disabled={busy || !emailValid} onClick={create}>
            {busy ? <span className="spinner" /> : 'Create invitation'}
          </button>
        </>
      ) : (
        <>
          <div className="qr">{qr ? <img src={qr} alt="Invitation QR code" className="qr__img" /> : <span className="spinner" />}</div>
          <p className="muted" style={{ textAlign: 'center' }}>
            Ask your colleague to scan this in Leagentex ({created.invitation.role === 'admin' ? 'admin' : 'member'}
            {created.invitation.email ? `, for ${created.invitation.email}` : ''}).
          </p>
          <div className="alert alert--warning">Single use, expires in 7 days. This code is shown only now — share it before closing.</div>
          <div className="row">
            <button className="btn btn--secondary" style={{ flex: 1 }} onClick={share}>
              {platform.share || 'share' in navigator ? <ShareIcon size={18} /> : <LinkIcon size={18} />} Share link
            </button>
            <button className="btn btn--secondary" style={{ flex: 1 }} onClick={emailInvite}>
              <MailIcon size={18} /> Email invite
            </button>
          </div>
          {notice && <div className="alert alert--info">{notice}</div>}
          {error && <div className="alert alert--error">{error}</div>}
          <button className="btn btn--primary btn--block" onClick={onClose}>
            Done
          </button>
        </>
      )}
    </Sheet>
  );
}
