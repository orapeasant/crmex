import { useCallback, useState, type ReactNode } from 'react';
import { useApp, useFirm } from '../context.js';
import { useMessaging } from '../messages/MessagingProvider.js';
import { AvatarMenu, type MenuPage } from '../ui/AvatarMenu.js';
import { BackIcon, BriefcaseIcon, MessageIcon, TasksIcon, UsersIcon } from '../ui/icons.js';
import { BACK_PRIORITY, useBackButton } from '../ui/util.js';
import { AccountPage } from '../pages/AccountPage.js';
import { LinkWhatsAppPage } from '../pages/LinkWhatsAppPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { BillingPage } from '../pages/BillingPage.js';
import { UsagePage } from '../pages/UsagePage.js';
import { FirmSettingsPage } from '../firm/FirmSettingsPage.js';
import { TabStack, type Route, type TabId } from './nav.js';
import { RouteView } from './routes.js';

const PAGE_TITLES: Record<MenuPage, string> = {
  account: 'Account',
  'link-whatsapp': 'Link WhatsApp',
  settings: 'Settings',
  firm: 'Firm & members',
  billing: 'Billing',
  usage: 'Usage',
};

const TABS: { id: TabId; label: string; icon: ReactNode; root: Route }[] = [
  { id: 'clients', label: 'Clients', icon: <UsersIcon size={22} />, root: { name: 'clients' } },
  { id: 'matters', label: 'Matters', icon: <BriefcaseIcon size={22} />, root: { name: 'matters' } },
  { id: 'tasks', label: 'Tasks', icon: <TasksIcon size={22} />, root: { name: 'tasks' } },
  { id: 'messages', label: 'Messages', icon: <MessageIcon size={22} />, root: { name: 'messages' } },
];

export function AppShell() {
  const { profile, signOut } = useApp();
  const firm = useFirm();
  const messaging = useMessaging();
  const [tab, setTab] = useState<TabId>('clients');
  const [visited, setVisited] = useState<Set<TabId>>(new Set(['clients']));
  const [page, setPage] = useState<MenuPage | null>(null);
  const [depths, setDepths] = useState<Record<TabId, number>>({ clients: 1, matters: 1, tasks: 1, messages: 1 });
  const [wizardFocus, setWizardFocus] = useState(false);

  const depthSetters = useState(() => {
    const make = (id: TabId) => (d: number) => setDepths((prev) => (prev[id] === d ? prev : { ...prev, [id]: d }));
    return { clients: make('clients'), matters: make('matters'), tasks: make('tasks'), messages: make('messages') };
  })[0];

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    window.scrollTo({ top: 0 });
  }, []);

  useBackButton(() => {
    if (!page) return false;
    setPage(page === 'firm' || page === 'link-whatsapp' ? (page === 'firm' ? 'settings' : null) : null);
    return true;
  }, BACK_PRIORITY.page);

  useBackButton(() => {
    if (page || tab === 'clients') return false;
    selectTab('clients');
    return true;
  }, BACK_PRIORITY.fallback);

  const atRoot = page === null && depths[tab] === 1;
  const showNav = atRoot && !(tab === 'messages' && wizardFocus);
  const whatsApp = messaging.whatsApp;

  return (
    <div className={showNav ? 'app app--nav' : 'app'}>
      {page !== null && (
        <header className="topbar">
          <button className="icon-btn" aria-label="Back" onClick={() => setPage(page === 'firm' ? 'settings' : null)}>
            <BackIcon />
          </button>
          <span className="topbar__title">{PAGE_TITLES[page]}</span>
          <span className="topbar__spacer" />
        </header>
      )}

      {atRoot && (
        <header className="topbar">
          <div className="topbar__brandblock">
            <span className="topbar__brand">Leagentex</span>
            {firm.activeOrg && <span className="topbar__firm">{firm.activeOrg.name}</span>}
          </div>
          <span className="topbar__spacer" />
          {messaging.jobActivity && (
            <span className="badge badge--neutral" title="Sending a message queued from your browser">
              <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Sending queued message…
            </span>
          )}
          {!messaging.jobActivity && whatsApp?.state === 'connecting' && (
            <span className="badge badge--neutral">
              <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Connecting
            </span>
          )}
          {!messaging.jobActivity && (whatsApp?.state === 'qr' || whatsApp?.state === 'logged-out') && (
            <button className="badge badge--warning badge--button" onClick={() => setPage('link-whatsapp')}>
              <span className="dot" /> WhatsApp not linked
            </button>
          )}
          <AvatarMenu
            profile={profile}
            onNavigate={setPage}
            onSignOut={() => void signOut()}
            showWhatsApp={messaging.mode === 'direct'}
            orgs={firm.orgs}
            activeOrgId={firm.activeOrg?.id ?? null}
            onSwitchFirm={(id) => void firm.switchFirm(id)}
          />
        </header>
      )}

      {/* Tabs stay mounted under menu pages so drafts and filters survive. Remounted per firm so nothing crosses firms. */}
      <div hidden={page !== null} key={firm.activeOrg?.id ?? 'none'}>
        {TABS.filter((t) => visited.has(t.id)).map((t) => (
          <div key={t.id} hidden={tab !== t.id}>
            <TabStack
              root={t.root}
              active={page === null && tab === t.id}
              onDepthChange={depthSetters[t.id]}
              render={(route) => <RouteView route={route} active={page === null && tab === t.id} onWizardFocus={setWizardFocus} onLinkWhatsApp={() => setPage('link-whatsapp')} />}
            />
          </div>
        ))}
      </div>

      {page === 'account' && <AccountPage onSignOut={() => void signOut()} />}
      {page === 'link-whatsapp' && <LinkWhatsAppPage />}
      {page === 'settings' && <SettingsPage onLinkWhatsApp={() => setPage('link-whatsapp')} onOpenFirm={() => setPage('firm')} />}
      {page === 'firm' && <FirmSettingsPage />}
      {page === 'billing' && <BillingPage />}
      {page === 'usage' && <UsagePage />}

      {showNav && (
        <nav className="bottomnav" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'bottomnav__item bottomnav__item--active' : 'bottomnav__item'} aria-current={tab === t.id ? 'page' : undefined} onClick={() => selectTab(t.id)}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
