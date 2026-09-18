// The signed-in desktop portal: firm gate, per-firm data scope, layout and routes.
// Rendered inside CrmexProviders (real session) or the dev preview harness.
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, LogOut, UserPlus } from 'lucide-react';
import { describeError, describeInviteError, parseInviteToken, useApp, useFirm, type PendingInvite } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { EmptyState, Spinner, TableSkeleton } from './components/common';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Field, FormError } from './components/form';
import { AppSidebar } from './layout/AppSidebar';
import { CreateActionsProvider } from './layout/CreateActions';
import { CrumbProvider, Topbar } from './layout/Topbar';

// Route-level code splitting: each section loads on first visit.
const ClientDetailPage = lazy(() => import('./clients/ClientDetailPage').then((m) => ({ default: m.ClientDetailPage })));
const ClientsPage = lazy(() => import('./clients/ClientsPage').then((m) => ({ default: m.ClientsPage })));
const MatterDetailPage = lazy(() => import('./matters/MatterDetailPage').then((m) => ({ default: m.MatterDetailPage })));
const MattersPage = lazy(() => import('./matters/MattersPage').then((m) => ({ default: m.MattersPage })));
const BatchDetailPage = lazy(() => import('./messages/BatchDetailPage').then((m) => ({ default: m.BatchDetailPage })));
const MessagesPage = lazy(() => import('./messages/MessagesPage').then((m) => ({ default: m.MessagesPage })));
const NewMessagePage = lazy(() => import('./messages/NewMessagePage').then((m) => ({ default: m.NewMessagePage })));
const FirmSettingsPage = lazy(() => import('./settings/FirmSettingsPage').then((m) => ({ default: m.FirmSettingsPage })));
const TasksPage = lazy(() => import('./tasks/TasksPage').then((m) => ({ default: m.TasksPage })));
const AccountPage = lazy(() => import('./settings/OtherSettingsPages').then((m) => ({ default: m.AccountPage })));
const BillingPage = lazy(() => import('./settings/OtherSettingsPages').then((m) => ({ default: m.BillingPage })));
const UsagePage = lazy(() => import('./settings/OtherSettingsPages').then((m) => ({ default: m.UsagePage })));

export function Portal({ invite }: { invite: PendingInvite }) {
  const firm = useFirm();
  const { user } = useApp();

  if (firm.status === 'loading') return <FullScreenMessage spinner text="Loading your firms…" />;
  if (firm.status === 'error') return <FirmLoadError />;

  return (
    <>
      <InviteRouteCapture invite={invite} />
      {firm.activeOrg ? <FirmScope key={`${user.id}:${firm.activeOrg.id}`} /> : <Onboarding invite={invite} />}
      <AcceptInviteDialog invite={invite} />
    </>
  );
}

/**
 * One QueryClient per user+firm: switching firms drops every cached row of
 * the previous firm and remounts all firm-scoped component state.
 */
function FirmScope() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } } }));
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <CreateActionsProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/clients" replace />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="clients/:clientId" element={<ClientDetailPage />} />
            <Route path="matters" element={<MattersPage />} />
            <Route path="matters/:matterId" element={<MatterDetailPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="messages" element={<MessagesPage />} />
            <Route path="messages/new" element={<NewMessagePage />} />
            <Route path="messages/batches/:batchId" element={<BatchDetailPage />} />
            <Route path="settings" element={<Navigate to="/settings/account" replace />} />
            <Route path="settings/firm" element={<FirmSettingsPage />} />
            <Route path="settings/account" element={<AccountPage />} />
            <Route path="settings/billing" element={<BillingPage />} />
            <Route path="settings/usage" element={<UsagePage />} />
            <Route path="invite/:token" element={<Navigate to="/clients" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </CreateActionsProvider>
    </QueryClientProvider>
  );
}

function AppLayout() {
  const { pathname } = useLocation();
  // The sidebar remembers expanded/collapsed in its own cookie; read it back on load.
  const [defaultOpen] = useState(() => !/(?:^|;\s*)sidebar_state=false/.test(document.cookie));
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset className="min-w-0 bg-background">
        <CrumbProvider render={(crumb) => <Topbar crumb={crumb} />}>
          <main id="main" className="min-w-0 flex-1">
            <ErrorBoundary resetKey={pathname}>
              <Suspense fallback={<div className="p-8"><TableSkeleton /></div>}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </main>
        </CrumbProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="p-8">
      <EmptyState title="Page not found" text="This address doesn't match a page in Leagentex." action={<Button onClick={() => navigate('/clients')}>Go to clients</Button>} />
    </div>
  );
}

/** /invite/:token taken by the router: remember the token and drop it from the address bar and history entry. */
function InviteRouteCapture({ invite }: { invite: PendingInvite }) {
  const location = useLocation();
  const navigate = useNavigate();
  const match = /^\/invite\/([^/]+)\/?$/.exec(location.pathname);
  const raw = match?.[1];
  useEffect(() => {
    if (!raw) return;
    const token = parseInviteToken(decodeURIComponent(raw));
    if (token) invite.set(token);
    navigate('/', { replace: true });
  }, [raw, invite, navigate]);
  return null;
}

function FullScreenMessage({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <div className="flex h-full min-h-screen items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
      {spinner && <Spinner className="text-primary" />} {text}
    </div>
  );
}

function FirmLoadError() {
  const firm = useFirm();
  const { profile, signOut } = useApp();
  const [retrying, setRetrying] = useState(false);
  return (
    <CenteredCard>
      <h1 className="text-xl font-semibold">Couldn't load your firms</h1>
      <p className="text-sm text-muted-foreground">{firm.error}</p>
      <div className="flex flex-col gap-2">
        <Button
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await firm.refresh();
            setRetrying(false);
          }}
        >
          {retrying && <Spinner />} Try again
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out ({profile.email})
        </Button>
      </div>
    </CenteredCard>
  );
}

export function CenteredCard({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-12">
      <div className={`flex w-full flex-col gap-5 rounded-xl border bg-card p-8 shadow-sm ${wide ? 'max-w-3xl' : 'max-w-md'}`}>{children}</div>
    </div>
  );
}

export function BrandMark({ className = 'size-10 text-lg' }: { className?: string }) {
  return <span className={`flex items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground ${className}`}>L</span>;
}

function Onboarding({ invite }: { invite: PendingInvite }) {
  const { api, profile, signOut } = useApp();
  const firm = useFirm();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  async function createFirm(e: React.FormEvent) {
    e.preventDefault();
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

  function join(e: React.FormEvent) {
    e.preventDefault();
    const token = parseInviteToken(code);
    if (!token) {
      setJoinError("That doesn't look like a Leagentex invitation. Paste the whole link or code you were sent.");
      return;
    }
    setJoinError(null);
    setCode('');
    invite.set(token);
  }

  return (
    <CenteredCard wide>
      <div className="flex items-center gap-3">
        <BrandMark />
        <div>
          <h1 className="text-xl font-semibold">Welcome{profile.fullName ? `, ${profile.fullName.split(' ')[0]}` : ''}</h1>
          <p className="text-sm text-muted-foreground">Leagentex works inside a firm. Create one for your practice, or join the firm that invited you.</p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={createFirm} className="flex flex-col gap-3 rounded-lg border p-5">
          <div className="flex items-center gap-2 font-medium">
            <Building2 className="size-4 text-primary" /> Create your firm
          </div>
          <p className="text-sm text-muted-foreground">You'll be its owner and can invite colleagues.</p>
          <Field id="firm-name" label="Firm name">
            <Input id="firm-name" placeholder="e.g. Tan & Partners LLP" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <FormError error={createError} />
          <Button type="submit" className="mt-auto" disabled={!name.trim() || creating}>
            {creating && <Spinner />} Create firm
          </Button>
        </form>
        <form onSubmit={join} className="flex flex-col gap-3 rounded-lg border p-5">
          <div className="flex items-center gap-2 font-medium">
            <UserPlus className="size-4 text-primary" /> Join a firm
          </div>
          <p className="text-sm text-muted-foreground">Paste the invitation link or code you received.</p>
          <Field id="invite-code" label="Invitation link or code">
            <Input id="invite-code" placeholder="https://…/invite/…" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <FormError error={joinError} />
          <Button type="submit" variant="secondary" className="mt-auto" disabled={!code.trim()}>
            Join
          </Button>
        </form>
      </div>
      <Button variant="ghost" className="self-center" onClick={() => void signOut()}>
        <LogOut /> Sign out ({profile.email})
      </Button>
    </CenteredCard>
  );
}

function AcceptInviteDialog({ invite }: { invite: PendingInvite }) {
  const { api } = useApp();
  const firm = useFirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(invite.token) || invite.invalidLink;
  const fatal = useMemo(() => Boolean(error && /different email|invalid|expired/i.test(error)), [error]);

  function close() {
    if (busy) return;
    setError(null);
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
      toast.success(`Welcome to ${org.name}`, { description: 'It is now your active firm. Switch firms from the sidebar.' });
    } catch (err) {
      setError(describeInviteError((err as { code?: string }).code, describeError(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        {invite.invalidLink && !invite.token ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation link not recognised</DialogTitle>
              <DialogDescription>This link doesn't contain a valid invitation. Ask the person who invited you to share it again.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={close}>Close</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Accept invitation?</DialogTitle>
              <DialogDescription>You've been invited to join a firm on Leagentex. Accepting adds you as a member and gives you access to the firm's clients, matters, tasks and messages.</DialogDescription>
            </DialogHeader>
            <FormError error={error} />
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>
                Not now
              </Button>
              <Button onClick={() => void accept()} disabled={busy || fatal}>
                {busy && <Spinner />} Accept
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
