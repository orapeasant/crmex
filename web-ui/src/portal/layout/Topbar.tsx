import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Briefcase, ListChecks, MessageSquare, Plus, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useCreateActions } from './CreateActions';
import { CommandSearch } from './CommandSearch';

const SECTIONS: Record<string, { label: string; to: string }> = {
  clients: { label: 'Clients', to: '/clients' },
  matters: { label: 'Matters', to: '/matters' },
  tasks: { label: 'Tasks', to: '/tasks' },
  messages: { label: 'Messages', to: '/messages' },
  settings: { label: 'Settings', to: '/settings/account' },
};

const CrumbCtx = createContext<(label: string | null) => void>(() => {});

/** Detail pages name the current record in the breadcrumb and the browser tab. */
export function useCrumb(label: string | null | undefined) {
  const set = useContext(CrumbCtx);
  useEffect(() => {
    if (label === undefined) return; // embedded views leave the page's crumb alone
    set(label);
    return () => set(null);
  }, [label, set]);
}

export function CrumbProvider({ children, render }: { children: ReactNode; render: (crumb: string | null) => ReactNode }) {
  const [crumb, setCrumb] = useState<string | null>(null);
  return (
    <CrumbCtx.Provider value={setCrumb}>
      {render(crumb)}
      {children}
    </CrumbCtx.Provider>
  );
}

const SUB_LABELS: Record<string, string> = { new: 'New message', firm: 'Firm & members', account: 'Account', billing: 'Billing', usage: 'Usage' };

export function Topbar({ crumb }: { crumb: string | null }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const create = useCreateActions();
  const [searchOpen, setSearchOpen] = useState(false);

  const [first, second, third] = pathname.split('/').filter(Boolean);
  const section = first ? SECTIONS[first] : undefined;
  const leaf = crumb ?? (second ? SUB_LABELS[third ?? second] : null);
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  useEffect(() => {
    const parts = [leaf, section?.label, 'Leagentex'].filter(Boolean);
    document.title = parts.join(' · ');
  }, [leaf, section]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="h-5 data-[orientation=vertical]:h-5" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {section && (
            <BreadcrumbItem className="shrink-0">
              {leaf ? (
                <BreadcrumbLink asChild>
                  <Link to={section.to}>{section.label}</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{section.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          )}
          {leaf && (
            <Fragment>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{leaf}</BreadcrumbPage>
              </BreadcrumbItem>
            </Fragment>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <Button variant="outline" className="h-9 w-9 justify-start gap-2 px-0 text-muted-foreground max-md:justify-center md:w-64 md:px-3 lg:w-80" onClick={() => setSearchOpen(true)} aria-label="Search clients and matters" aria-keyshortcuts="Control+K Meta+K">
        <Search className="size-4" />
        <span className="hidden flex-1 text-left font-normal md:inline">Search clients, matters…</span>
        <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 font-mono text-[10px] font-medium md:inline">{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus /> <span className="hidden sm:inline">New</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={create.newClient}>
            <Users /> Client
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={create.newMatter}>
            <Briefcase /> Matter
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => create.newTask()}>
            <ListChecks /> Task
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate('/messages/new')}>
            <MessageSquare /> Message
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </header>
  );
}
