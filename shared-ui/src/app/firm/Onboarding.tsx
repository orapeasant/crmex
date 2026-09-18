import { useState } from 'react';
import { parseInviteToken } from '../../crm/invite.js';
import { useApp, useFirm } from '../context.js';
import { BuildingIcon, LogoutIcon, ScanIcon, UserPlusIcon } from '../ui/icons.js';
import { describeError } from '../ui/util.js';
import type { PendingInvite } from './invites.js';

/** Shown after sign-in when the user belongs to no firm (crmex.md §15.2). */
export function Onboarding({ invite }: { invite: PendingInvite }) {
  const { api, platform, profile, signOut } = useApp();
  const firm = useFirm();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function createFirm() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const org = await api.createOrg(trimmed);
      await firm.adoptFirm(org.id);
    } catch (err) {
      setCreateError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  function applyCode(raw: string) {
    const token = parseInviteToken(raw);
    if (!token) {
      setJoinError("That doesn't look like a Leagentex invitation. Paste the whole link or code you were sent.");
      return;
    }
    setJoinError(null);
    setCode('');
    invite.set(token);
  }

  async function scan() {
    if (!platform.scanQrCode) return;
    setScanning(true);
    setJoinError(null);
    try {
      const value = await platform.scanQrCode();
      if (value) applyCode(value);
    } catch (err) {
      setJoinError(`Couldn't scan: ${describeError(err)}`);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div className="signin__logo">L</div>
        <div>
          <h1 className="section-title" style={{ fontSize: 24 }}>
            Welcome{profile.fullName ? `, ${profile.fullName.split(' ')[0]}` : ''}
          </h1>
          <p className="section-subtitle">Leagentex works inside a firm. Create one for your practice, or join the firm that invited you.</p>
        </div>
      </div>

      <section className="card stack">
        <div className="row">
          <span className="icon-tile">
            <BuildingIcon size={20} />
          </span>
          <div>
            <div className="card__title">Create your firm</div>
            <div className="card__subtitle">You'll be its owner and can invite colleagues.</div>
          </div>
        </div>
        <label className="field">
          <span className="field__label">Firm name</span>
          <input className="input" placeholder="e.g. Tan & Partners LLP" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createFirm()} />
        </label>
        {createError && <div className="alert alert--error">{createError}</div>}
        <button className="btn btn--primary btn--block" disabled={!name.trim() || creating} onClick={createFirm}>
          {creating ? <span className="spinner" /> : 'Create firm'}
        </button>
      </section>

      <section className="card stack">
        <div className="row">
          <span className="icon-tile">
            <UserPlusIcon size={20} />
          </span>
          <div>
            <div className="card__title">Join a firm</div>
            <div className="card__subtitle">Use the invitation QR code or link you received.</div>
          </div>
        </div>
        {platform.scanQrCode && (
          <button className="btn btn--secondary btn--block" onClick={scan} disabled={scanning}>
            {scanning ? <span className="spinner" /> : <ScanIcon size={18} />} Scan QR code
          </button>
        )}
        <label className="field">
          <span className="field__label">Invitation link or code</span>
          <div className="ai-row">
            <input className="input" placeholder="crmex://invite/…" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyCode(code)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button className="btn btn--secondary" disabled={!code.trim()} onClick={() => applyCode(code)}>
              Join
            </button>
          </div>
        </label>
        {joinError && <div className="alert alert--error">{joinError}</div>}
      </section>

      <button className="btn btn--ghost" onClick={() => void signOut()}>
        <LogoutIcon size={18} /> Sign out ({profile.email})
      </button>
    </div>
  );
}
