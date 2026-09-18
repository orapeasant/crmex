import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Ban, Briefcase, ListChecks, Mail, MessageSquare, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { MATTER_CLIENT_ROLES, clientKindLabel, deleteClient, describeError, formatDate, formatDateTime, groupTasks, setClientSuppressed, updateClient, useActiveFirm, useApp } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, ErrorState, Fact, Initials, Section, StatusBadge, TableSkeleton } from '../components/common';
import { DetailTabs, TabCount } from '../components/DetailTabs';
import { NotesEditor } from '../components/NotesEditor';
import { useCreateActions } from '../layout/CreateActions';
import { useCrumb } from '../layout/Topbar';
import { useClient, useClientMatters, useClientMessages, useInvalidateFirm, useMatters, useMemberRows, useTasks } from '../lib/queries';
import { MatterStatusBadge } from '../matters/MatterStatusBadge';
import { RecipientStatusBadge } from '../messages/badges';
import { TaskTable } from '../tasks/TaskTable';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export function ClientDetailPage() {
  const { clientId = '' } = useParams();
  const client = useClient(clientId);
  const c = client.data;
  useCrumb(c?.display_name ?? (client.isLoading ? '…' : 'Client'));

  if (client.isLoading) {
    return (
      <div className="p-8">
        <TableSkeleton rows={4} />
      </div>
    );
  }
  if (client.isError) {
    return (
      <div className="p-8">
        <ErrorState error={client.error} onRetry={() => void client.refetch()} title="Couldn't load this client" />
      </div>
    );
  }
  if (!c) {
    return (
      <div className="p-8">
        <EmptyState title="Client not found" text="It may have been deleted, or it belongs to another firm." action={<Button variant="outline" asChild><Link to="/clients">Back to clients</Link></Button>} />
      </div>
    );
  }
  return <ClientDetail clientId={clientId} />;
}

function ClientDetail({ clientId }: { clientId: string }) {
  const { supabase, openUrl } = useApp();
  const { orgId, canManage } = useActiveFirm();
  const navigate = useNavigate();
  const create = useCreateActions();
  const invalidate = useInvalidateFirm();
  const c = useClient(clientId).data!;
  const matters = useClientMatters(clientId);
  const messages = useClientMessages(clientId);
  const tasks = useTasks();
  const allMatters = useMatters();
  const members = useMemberRows();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const matterIds = useMemo(() => new Set((matters.data ?? []).map((m) => m.matter.id)), [matters.data]);
  const clientTasks = useMemo(() => (tasks.data ?? []).filter((t) => t.matter_id && matterIds.has(t.matter_id)), [tasks.data, matterIds]);
  const taskGroups = useMemo(() => {
    const s = groupTasks(clientTasks);
    return [
      { key: 'overdue', label: 'Overdue', tone: 'danger' as const, tasks: s.overdue },
      { key: 'today', label: 'Today', tasks: s.today },
      { key: 'upcoming', label: 'Upcoming', tasks: s.upcoming },
      { key: 'nodate', label: 'No date', tasks: s.noDate },
      { key: 'done', label: 'Done', tasks: s.done },
    ];
  }, [clientTasks]);

  const sendable = !c.suppressed_at && Boolean(c.phone_e164 && E164.test(c.phone_e164));
  const digits = c.phone_e164?.replace(/[^0-9]/g, '') ?? '';

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      await invalidate();
      toast.success(success);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteClient(supabase, orgId, c.id);
      toast.success(`${c.display_name} deleted`);
      setConfirmDelete(false);
      navigate('/clients', { replace: true });
      await invalidate();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const overview = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Section title="Contact details" className="xl:col-span-2">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Fact label="Mobile phone">{c.phone_e164 ? <a className="font-mono hover:underline" href={`tel:${c.phone_e164}`}>{c.phone_e164}</a> : '—'}</Fact>
          <Fact label="Email">{c.email ? <a className="hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : '—'}</Fact>
          <Fact label="Kind">{clientKindLabel(c.kind)}</Fact>
          <Fact label="Source">{c.source === 'phone_import' ? 'Imported from phone' : 'Added manually'}</Fact>
          <Fact label="Added">{formatDate(c.created_at)}</Fact>
          <Fact label="Last updated">{formatDateTime(c.updated_at)}</Fact>
        </dl>
      </Section>
      <Section title="Messaging consent">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Opted in</div>
              <div className="text-xs text-muted-foreground">{c.opted_in_at ? `Recorded ${formatDate(c.opted_in_at)}` : 'No opt-in recorded'}</div>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => updateClient(supabase, orgId, c.id, { opted_in_at: c.opted_in_at ? null : new Date().toISOString() }), c.opted_in_at ? 'Opt-in cleared' : 'Opt-in recorded')}>
              {c.opted_in_at ? 'Clear' : 'Record now'}
            </Button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <label htmlFor="suppress" className="text-sm font-medium">
                Suppress messages
              </label>
              <div className="text-xs text-muted-foreground">{c.suppressed_at ? `Opted out ${formatDate(c.suppressed_at)} — never messaged` : 'Turn on if this client asked not to be contacted'}</div>
            </div>
            <Switch id="suppress" checked={Boolean(c.suppressed_at)} disabled={busy} onCheckedChange={(v) => act(() => setClientSuppressed(supabase, orgId, c.id, v), v ? 'Messages suppressed' : 'Suppression lifted')} />
          </div>
        </div>
      </Section>
      <Section title="Recent messages" className="xl:col-span-3" actions={<Button size="sm" variant="ghost" asChild><Link to="?tab=messages">View all</Link></Button>}>
        {messages.data && messages.data.length > 0 ? (
          <ul className="divide-y">
            {messages.data.slice(0, 3).map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0">
                <span className="w-36 shrink-0 text-muted-foreground tabular-nums">{formatDateTime(m.created_at)}</span>
                <Link to={`/messages/batches/${m.batch_id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {m.body?.trim() || (m.media_path ? 'Image' : 'Message')}
                </Link>
                <RecipientStatusBadge status={m.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{messages.isLoading ? 'Loading…' : 'No messages sent to this client yet.'}</p>
        )}
      </Section>
    </div>
  );

  const mattersTab = matters.isLoading ? (
    <TableSkeleton rows={3} />
  ) : matters.isError ? (
    <ErrorState error={matters.error} onRetry={() => void matters.refetch()} />
  ) : (matters.data ?? []).length === 0 ? (
    <EmptyState icon={<Briefcase />} title="Not linked to any matter" text="Link clients from a matter's People tab." />
  ) : (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-32 text-xs uppercase">Number</TableHead>
            <TableHead className="text-xs uppercase">Title</TableHead>
            <TableHead className="text-xs uppercase">Role</TableHead>
            <TableHead className="w-28 text-xs uppercase">Status</TableHead>
            <TableHead className="w-32 text-xs uppercase">Opened</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {matters.data!.map(({ matter, role }) => (
            <TableRow key={matter.id} className="cursor-pointer" tabIndex={0} onClick={() => navigate(`/matters/${matter.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/matters/${matter.id}`)}>
              <TableCell className="font-mono text-[13px]">{matter.matter_number}</TableCell>
              <TableCell className="font-medium">{matter.title}</TableCell>
              <TableCell className="text-muted-foreground">{MATTER_CLIENT_ROLES.find((r) => r.value === role)?.label ?? role}</TableCell>
              <TableCell>
                <MatterStatusBadge status={matter.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(matter.opened_on)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  const messagesTab = messages.isLoading ? (
    <TableSkeleton rows={3} />
  ) : messages.isError ? (
    <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
  ) : (messages.data ?? []).length === 0 ? (
    <EmptyState icon={<MessageSquare />} title="No messages yet" text="Messages sent to this client from any firm member appear here." />
  ) : (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="w-44 text-xs uppercase">Sent</TableHead>
            <TableHead className="text-xs uppercase">Message</TableHead>
            <TableHead className="w-32 text-xs uppercase">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.data!.map((m) => (
            <TableRow key={m.id} className="cursor-pointer" tabIndex={0} onClick={() => navigate(`/messages/batches/${m.batch_id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/messages/batches/${m.batch_id}`)}>
              <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(m.created_at)}</TableCell>
              <TableCell className="max-w-[36rem] truncate">{m.body?.trim() || (m.media_path ? 'Image' : 'Message')}</TableCell>
              <TableCell>
                <RecipientStatusBadge status={m.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <>
      <div className="border-b bg-card px-6 pt-6 pb-5 lg:px-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-4">
          <Initials name={c.display_name} className="size-14 text-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{c.display_name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge>{clientKindLabel(c.kind)}</StatusBadge>
              {c.suppressed_at && (
                <StatusBadge tone="warning">
                  <Ban className="size-3" /> Opted out
                </StatusBadge>
              )}
              {c.opted_in_at && !c.suppressed_at && <StatusBadge tone="success">Opted in</StatusBadge>}
              {c.tags.map((t) => (
                <StatusBadge key={t} tone="brand">
                  {t}
                </StatusBadge>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Phone className="size-3.5" /> {c.phone_e164 ?? 'No mobile number'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Mail className="size-3.5" /> {c.email ?? 'No email'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Briefcase className="size-3.5" /> {matters.data ? `${matters.data.length} ${matters.data.length === 1 ? 'matter' : 'matters'}` : '…'}
              </span>
            </div>
          </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => create.editClient(c)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" onClick={() => create.newTask()}>
              <Plus /> New task
            </Button>
            {digits && (
              <Button variant="outline" onClick={() => openUrl(`https://wa.me/${digits}`)} title="Open a WhatsApp chat">
                <MessageSquare /> WhatsApp
              </Button>
            )}
            <Button disabled={!sendable} onClick={() => navigate(`/messages/new?to=${c.id}`)} title={sendable ? undefined : c.suppressed_at ? 'This client opted out of messages' : 'Add a mobile number to message this client'}>
              <MessageSquare /> Send message
            </Button>
            {canManage && (
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Delete client">
                <Trash2 />
              </Button>
            )}
          </div>
        </div>
      </div>

      <DetailTabs
        tabs={[
          { value: 'overview', label: 'Overview', content: overview },
          { value: 'matters', label: <>Matters<TabCount n={matters.data?.length} /></>, content: mattersTab },
          {
            value: 'tasks',
            label: <>Tasks<TabCount n={tasks.data ? clientTasks.filter((t) => t.status === 'open').length : undefined} /></>,
            content:
              clientTasks.length === 0 && tasks.isSuccess ? (
                <EmptyState icon={<ListChecks />} title="No tasks" text="Tasks on this client's matters appear here." />
              ) : (
                <TaskTable groups={taskGroups} members={members.data ?? []} matters={allMatters.data} onOpen={create.editTask} />
              ),
          },
          { value: 'messages', label: <>Messages<TabCount n={messages.data?.length} /></>, content: messagesTab },
          { value: 'notes', label: 'Notes', content: <NotesEditor label="Client notes" value={c.notes} onSave={async (notes) => { await updateClient(supabase, orgId, c.id, { notes }); await invalidate(); }} /> },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${c.display_name}?`}
        description="The client is removed from the firm and unlinked from its matters. Messages already sent stay in the history."
        confirmLabel="Delete client"
        destructive
        busy={busy}
        onConfirm={() => void remove()}
      />
    </>
  );
}
