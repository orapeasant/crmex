import { useEffect, useState, type ReactNode } from 'react';
import type { OrgSummary } from '../../types.js';
import { Avatar, type UserProfile } from './Avatar.js';
import { BuildingIcon, CardIcon, ChartIcon, CheckIcon, LogoutIcon, QrIcon, SettingsIcon, UserIcon } from './icons.js';
import { BACK_PRIORITY, useBackButton } from './util.js';

export type MenuPage = 'account' | 'link-whatsapp' | 'settings' | 'firm' | 'billing' | 'usage';

export interface AvatarMenuProps {
  profile: UserProfile;
  onNavigate: (page: MenuPage) => void;
  onSignOut: () => void;
  /** Only on platforms that hold a WhatsApp session. */
  showWhatsApp: boolean;
  orgs: OrgSummary[];
  activeOrgId: string | null;
  onSwitchFirm: (orgId: string) => void;
}

export function AvatarMenu({ profile, onNavigate, onSignOut, showWhatsApp, orgs, activeOrgId, onSwitchFirm }: AvatarMenuProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useBackButton(() => {
    if (!open) return false;
    setOpen(false);
    return true;
  }, BACK_PRIORITY.overlay);

  function item(page: MenuPage, label: string, icon: ReactNode) {
    return (
      <button
        className="menu__item"
        role="menuitem"
        onClick={() => {
          setOpen(false);
          onNavigate(page);
        }}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <>
      <button className="avatar-button" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar initials={profile.initials} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu" role="menu">
            <div className="menu__header">
              <Avatar initials={profile.initials} size={44} />
              <div style={{ minWidth: 0 }}>
                <div className="menu__name">{profile.fullName}</div>
                <div className="menu__email">{profile.email}</div>
              </div>
            </div>
            {orgs.length > 1 && (
              <>
                <div className="menu__divider" />
                <div className="menu__section">Switch firm</div>
                {orgs.map((o) => (
                  <button
                    key={o.id}
                    className="menu__item"
                    role="menuitemradio"
                    aria-checked={o.id === activeOrgId}
                    onClick={() => {
                      setOpen(false);
                      if (o.id !== activeOrgId) onSwitchFirm(o.id);
                    }}
                  >
                    <BuildingIcon />
                    <span className="menu__label">{o.name}</span>
                    {o.id === activeOrgId && (
                      <span style={{ color: 'var(--primary)', display: 'inline-flex' }}>
                        <CheckIcon size={18} />
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
            <div className="menu__divider" />
            {item('account', 'Account', <UserIcon />)}
            {showWhatsApp && item('link-whatsapp', 'Link WhatsApp (QR code)', <QrIcon />)}
            {item('settings', 'Settings', <SettingsIcon />)}
            {item('billing', 'Billing', <CardIcon />)}
            {item('usage', 'Usage', <ChartIcon />)}
            <div className="menu__divider" />
            <button
              className="menu__item menu__item--danger"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <LogoutIcon />
              Log out
            </button>
          </div>
        </>
      )}
    </>
  );
}
