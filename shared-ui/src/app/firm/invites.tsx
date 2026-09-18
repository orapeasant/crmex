import { useCallback, useEffect, useState } from 'react';
import { describeInviteError, parseInviteToken } from '../../crm/invite.js';
import type { PlatformServices } from '../platform.js';
import { useApp, useFirm } from '../context.js';
import { Sheet } from '../ui/components.js';
import { describeError } from '../ui/util.js';

export interface PendingInvite {
  token: string | null;
  /** A link arrived but did not contain a well-formed token. */
  invalidLink: boolean;
  set: (token: string) => void;
  clear: () => void;
}

/**
 * Captures invitation links for the whole app lifetime — including a cold
 * start from the link and links opened before sign-in — so the invite can be
 * offered once a session and the firm list exist.
 */
export function usePendingInvite(platform: PlatformServices): PendingInvite {
  const [token, setToken] = useState<string | null>(null);
  const [invalidLink, setInvalidLink] = useState(false);

  useEffect(() => {
    const links = platform.links;
    if (!links) return;
    const take = (url: string | null) => {
      if (!url) return;
      const parsed = parseInviteToken(url);
      if (parsed) {
        setToken(parsed);
        setInvalidLink(false);
      } else if (/invite/i.test(url)) {
        setInvalidLink(true);
      }
      links.consumed?.();
    };
    links.getInitialUrl().then(take).catch(() => {});
    return links.subscribe(take);
  }, [platform]);

  const set = useCallback((t: string) => {
    setToken(t);
    setInvalidLink(false);
  }, []);
  const clear = useCallback(() => {
    setToken(null);
    setInvalidLink(false);
  }, []);
  return { token, invalidLink, set, clear };
}

/** "Accept invitation?" confirmation. The firm name is unknown until the server accepts the token. */
export function AcceptInviteSheet({ invite }: { invite: PendingInvite }) {
  const { api } = useApp();
  const firm = useFirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  const open = Boolean(invite.token) || invite.invalidLink || joined !== null;

  function close() {
    if (busy) return;
    setError(null);
    setJoined(null);
    invite.clear();
  }

  async function accept() {
    if (!invite.token) return;
    setBusy(true);
    setError(null);
    try {
      const org = await api.acceptInvitation(invite.token);
      invite.clear();
      await firm.adoptFirm(org.id);
      setJoined(org.name);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(describeInviteError(code, describeError(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={close} title={joined ? `Welcome to ${joined}` : invite.invalidLink && !invite.token ? 'Invitation link not recognised' : 'Accept invitation?'}>
      {joined ? (
        <>
          <p className="muted">You're now a member of {joined}. It is your active firm; switch firms from the account menu.</p>
          <button className="btn btn--primary btn--block" onClick={close}>
            Continue
          </button>
        </>
      ) : invite.invalidLink && !invite.token ? (
        <>
          <p className="muted">This link doesn't contain a valid invitation. Ask the person who invited you to share it again.</p>
          <button className="btn btn--secondary btn--block" onClick={close}>
            Close
          </button>
        </>
      ) : (
        <>
          <p className="muted">You've been invited to join a firm on Leagentex. Accepting adds you as a member and gives you access to the firm's clients, matters, tasks and messages.</p>
          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <button className="btn btn--secondary" style={{ flex: 1 }} onClick={close} disabled={busy}>
              Not now
            </button>
            <button className="btn btn--primary" style={{ flex: 1 }} onClick={accept} disabled={busy || Boolean(error && /different email|invalid/.test(error))}>
              {busy ? <span className="spinner" /> : 'Accept'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
