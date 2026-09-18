import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { HttpApiClient } from '../api/httpApiClient.js';
import type { OrgRole, OrgSummary } from '../types.js';
import type { PlatformServices } from './platform.js';
import type { UserProfile } from './ui/Avatar.js';
import { describeError } from './ui/util.js';

// ---------------------------------------------------------------------------
// App (session-level) context
// ---------------------------------------------------------------------------

export interface AppContextValue {
  platform: PlatformServices;
  supabase: SupabaseClient;
  api: HttpApiClient;
  user: User;
  profile: UserProfile;
  signOut: () => Promise<void>;
  openUrl: (url: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
export const AppContextProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp outside AppContextProvider');
  return v;
}

// ---------------------------------------------------------------------------
// Firm context (crmex.md §15.2): memberships, active firm, role
// ---------------------------------------------------------------------------

export interface FirmContextValue {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  orgs: OrgSummary[];
  activeOrg: OrgSummary | null;
  role: OrgRole | null;
  /** Owner or admin: may delete clients/matters and manage members. */
  canManage: boolean;
  switchFirm: (orgId: string) => Promise<void>;
  /** Makes a firm the active one after joining or creating it, then reloads memberships. */
  adoptFirm: (orgId: string) => Promise<void>;
  /** Re-reads memberships from core-server and re-validates the active firm. */
  refresh: () => Promise<void>;
  /** Increments whenever firm data changed locally, so mounted lists reload. */
  dataVersion: number;
  bump: () => void;
}

const FirmContext = createContext<FirmContextValue | null>(null);

export function useFirm(): FirmContextValue {
  const v = useContext(FirmContext);
  if (!v) throw new Error('useFirm outside FirmProvider');
  return v;
}

/** The active firm, for screens that only render once one exists. */
export function useActiveFirm(): FirmContextValue & { orgId: string; activeOrg: OrgSummary; role: OrgRole } {
  const f = useFirm();
  if (!f.activeOrg || !f.role) throw new Error('useActiveFirm without an active firm');
  return { ...f, orgId: f.activeOrg.id, activeOrg: f.activeOrg, role: f.role };
}

const activeFirmKey = (userId: string) => `firm.active.${userId}`;

export function FirmProvider({
  api,
  platform,
  userId,
  orgIdRef,
  children,
}: {
  api: HttpApiClient;
  platform: PlatformServices;
  userId: string;
  /** Written synchronously so HttpApiClient's getOrgId sees the active firm. */
  orgIdRef: MutableRefObject<string | null>;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<FirmContextValue['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const loadSeq = useRef(0);

  const load = useCallback(async (background: boolean) => {
    const seq = ++loadSeq.current;
    try {
      const list = await api.listOrgs();
      if (seq !== loadSeq.current) return;
      const key = activeFirmKey(userId);
      let stored = await platform.preferences.get(key).catch(() => null);
      if (stored && !list.some((o) => o.id === stored)) {
        // No longer a member: drop everything local for that firm before showing anything else (§15.6).
        await platform.purgeFirmData?.(userId, stored).catch(() => {});
        await platform.preferences.remove(key).catch(() => {});
        stored = null;
      }
      const next = stored ?? list[0]?.id ?? null;
      if (next && next !== stored) await platform.preferences.set(key, next).catch(() => {});
      if (seq !== loadSeq.current) return;
      orgIdRef.current = next;
      setOrgs(list);
      setActiveOrgId((prev) => {
        if (prev !== next) setDataVersion((v) => v + 1);
        return next;
      });
      setError(null);
      setStatus('ready');
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // A background re-check that merely failed to reach the server keeps the verified state.
      if (background) return;
      // Never fall back to a cached membership: stale firm data must not be shown.
      orgIdRef.current = null;
      setOrgs([]);
      setActiveOrgId(null);
      setError(describeError(err));
      setStatus('error');
    }
  }, [api, platform, userId, orgIdRef]);
  const refresh = useCallback(() => load(false), [load]);

  useEffect(() => {
    setStatus('loading');
    void refresh();
  }, [refresh]);

  // Re-validate membership whenever the app comes back to the foreground.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void load(true);
    document.addEventListener('visibilitychange', onVisible);
    const offResume = platform.onResume?.(() => void load(true));
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      offResume?.();
    };
  }, [platform, load]);

  const switchFirm = useCallback(
    async (orgId: string) => {
      if (!orgs.some((o) => o.id === orgId)) return;
      orgIdRef.current = orgId;
      setActiveOrgId(orgId);
      setDataVersion((v) => v + 1);
      await platform.preferences.set(activeFirmKey(userId), orgId).catch(() => {});
    },
    [orgs, orgIdRef, platform, userId],
  );

  const adoptFirm = useCallback(
    async (orgId: string) => {
      await platform.preferences.set(activeFirmKey(userId), orgId).catch(() => {});
      await refresh();
    },
    [platform, userId, refresh],
  );

  const bump = useCallback(() => setDataVersion((v) => v + 1), []);

  const value = useMemo<FirmContextValue>(() => {
    const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;
    const role = activeOrg?.role ?? null;
    return { status, error, orgs, activeOrg, role, canManage: role === 'owner' || role === 'admin', switchFirm, adoptFirm, refresh, dataVersion, bump };
  }, [status, error, orgs, activeOrgId, switchFirm, adoptFirm, refresh, dataVersion, bump]);

  return <FirmContext.Provider value={value}>{children}</FirmContext.Provider>;
}
