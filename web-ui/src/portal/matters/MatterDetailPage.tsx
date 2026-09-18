import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, ListChecks, MessageSquare, Pencil, Plus, Trash2, UserMinus, Users } from 'lucide-react';
import {
  MATTER_CLIENT_ROLES,
  deleteMatter,
  describeError,
  formatDate,
  formatDateTime,
  formatDue,
  groupTasks,
  linkClientToMatter,
  listMessageHistory,
  unlinkClientFromMatter,
  updateMatter,
  useActiveFirm,
  useApp,
  type MatterClientRole,
} from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, ErrorState, Fact, Initials, Section, TableSkeleton } from '../components/common';
import { DetailTabs, TabCount } from '../components/DetailTabs';
import { NotesEditor } from '../components/NotesEditor';
import { useCreateActions } from '../layout/CreateActions';
import { useCrumb } from '../layout/Topbar';
import { useClients, useInvalidateFirm, useMatter, useMatterLinks, useMemberRows, useTasks } from '../lib/queries';
import { RecipientStatusBadge } from '../messages/badges';
import { KindBadge, TaskTable } from '../tasks/TaskTable';
import { LinkClientDialog } from './LinkClientDialog';
import { MatterStatusBadge } from './MatterStatusBadge';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export function MatterDetailPage() {
  const { matterId = '' } = useParams();
  const matter = useMatter(matterId);
  useCrumb(matter.data ? `${matter.data.matter_number} · ${matter.data.title}` : matter.isLoading ? '…' : 'Matter');
  if (matter.isLoading)
    return (
      <div className="p-8">
        <TableSkeleton rows={4} />
      </div>
    );
  if (matter.isError)
    return (
      <div className="p-8">
        <ErrorState error={matter.error} onRetry={() => void matter.refetch()} title="Couldn't load this matter" />
      </div>
    );
  if (!matter.data)
    return (
      <div className="p-8">
        <EmptyState title="Matter not found" text="It may have been deleted, or it belongs to another firm." action={<Button variant="outline" asChild><Link to="/matters">Back to matters</Link></Button>} />
      </div>
    );
  return <MatterDetail matterId={matterId} />;
}

function MatterDetail({ matterId }: { matterId: string }) {
  const { supabase } = useApp();
  const { orgId, canManage } = useActiveFirm();
  const navigate = useNavigate();
  const create = useCreateActions();
  const invalidate = useInvalidateFirm();
  const m = useMatter(matterId).data!;
  const links = useMatterLinks(matterId);
  const clients = useClients();
  const tasks = useTasks();
  const members = useMemberRows();
  const [linking, setLinking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const clientById = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c])), [clients.data]);
  const people = useMemo(() => (links.data ?? []).flatMap((l) => (clientById.get(l.client_id) ? [{ link: l, client: clientById.get(l.client_id)! }] : [])), [links.data, clientById]);
  const peopleIds = useMemo(() => people.map((p) => p.client.id), [people]);
  const matterTasks = useMemo(() => (tasks.data ?? []).filter((t) => t.matter_id === matterId), [tasks.data, matterId]);
  const groups = useMemo(() => {
    const s = groupTasks(matterTasks);
    return [
      { key: 'overdue', label: 'Overdue', tone: 'danger' as const, tasks: s.overdue },
      { key: 'today', label: 'Today', tasks: s.today },
      { key: 'upcoming', label: 'Upcoming', tasks: s.upcoming },
      { key: 'nodate', label: 'No date', tasks: s.noDate },
      { key: 'done', label: 'Done', tasks: s.done },
    ];
  }, [matterTasks]);
  const upcoming = useMemo(() => {
    const s = groupTasks(matterTasks);
    return [...s.overdue, ...s.today, ...s.upcoming].slice(0, 5);
  }, [matterTasks]);

  // message_history has no matter column: show messages sent to this matter's people.
  const messages = useQuery({
    queryKey: ['org', orgId, 'matter', matterId, 'messages', peopleIds],
    enabled: links.isSuccess,
    queryFn: async () => {
      if (peopleIds.length === 0) return [];
      const lists = await Promise.all(peopleIds.map((clientId) => listMessageHistory(supabase, orgId, { clientId, limit: 50 })));
      return lists.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  });

  const sendableIds = people.filter((p) => !p.client.suppressed_at && p.client.phone_e164 && E164.test(p.client.phone_e164)).map((p) => p.client.id);
  const openTasks = matterTasks.filter((t) => t.status === 'open').length;

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      await invalidate();
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const peopleTab = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Clients and other parties linked to this matter.</p>
        <Button size="sm" onClick={() => setLinking(true)}>
          <Plus /> Link client
        </Button>
      </div>
      {links.isLoading || clients.isLoading ? (
        <TableSkeleton rows={3} />
      ) : links.isError ? (
        <ErrorState error={links.error} onRetry={() => void links.refetch()} />
      ) : people.length === 0 ? (
        <EmptyState icon={<Users />} title="No one linked yet" text="Link the client, opposing parties and witnesses for this matter." />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs uppercase">Name</TableHead>
                <TableHead className="w-44 text-xs uppercase">Role</TableHead>
                <TableHead className="text-xs uppercase">Phone</TableHead>
                <TableHead className="hidden text-xs uppercase lg:table-cell">Email</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map(({ link, client }) => (
                <TableRow key={client.id} className="cursor-pointer" tabIndex={0} onClick={() => navigate(`/clients/${client.id}`)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate(`/clients/${client.id}`)}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Initials name={client.display_name} />
                      <span className="font-medium">{client.display_name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{MATTER_CLIENT_ROLES.find((r) => r.value === link.role)?.label ?? link.role}</TableCell>
                  <TableCell className="font-mono text-[13px]">{client.phone_e164 ?? '—'}</TableCell>
                  <TableCell className="hidden lg:table-cell">{client.email ?? '—'}</TableCell>
                  <TableCell>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Unlink ${client.display_name}`}
                      title="Unlink from matter"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(() => unlinkClientFromMatter(supabase, orgId, matterId, client.id), `${client.display_name} unlinked`);
                      }}
                    >
                      <UserMinus />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );

  const overview = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <Section title="Details" className="xl:col-span-2">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <Fact label="Matter number">
            <span className="font-mono">{m.matter_number}</span>
          </Fact>
          <Fact label="Status">
            <MatterStatusBadge status={m.status} />
          </Fact>
          <Fact label="Practice area">{m.practice_area ?? '—'}</Fact>
          <Fact label="Opened">{formatDate(m.opened_on)}</Fact>
          <Fact label="Closed">{m.closed_on ? formatDate(m.closed_on) : '—'}</Fact>
          <Fact label="Last updated">{formatDateTime(m.updated_at)}</Fact>
        </dl>
      </Section>
      <Section title="Next deadlines" actions={<Button size="sm" variant="ghost" onClick={() => create.newTask({ matterId })}><Plus /> Add</Button>}>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open tasks with a due date.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {upcoming.map((t) => (
              <li key={t.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded text-left text-sm hover:underline" onClick={() => create.editTask(t)}>
                  <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <KindBadge kind={t.kind} />
                  <span className={`w-24 shrink-0 text-right tabular-nums ${t.due_at && new Date(t.due_at).getTime() < Date.now() ? 'font-medium text-red-700 dark:text-red-300' : 'text-muted-foreground'}`}>{formatDue(t.due_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="People" className="xl:col-span-3" actions={<Button size="sm" variant="ghost" asChild><Link to="?tab=people">Manage</Link></Button>}>
        {people.length === 0 ? (
          <p className="text-sm text-muted-foreground">{links.isLoading ? 'Loading…' : 'No clients linked yet.'}</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {people.map(({ link, client }) => (
              <Link key={client.id} to={`/clients/${client.id}`} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
                <Initials name={client.display_name} className="size-7" />
                <span className="font-medium">{client.display_name}</span>
                <span className="text-muted-foreground">· {MATTER_CLIENT_ROLES.find((r) => r.value === link.role)?.label}</span>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  );

  const messagesTab =
    messages.isLoading || !links.isSuccess ? (
      <TableSkeleton rows={3} />
    ) : messages.isError ? (
      <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
    ) : (messages.data ?? []).length === 0 ? (
      <EmptyState icon={<MessageSquare />} title="No messages yet" text="Messages sent to this matter's people appear here." />
    ) : (
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-44 text-xs uppercase">Sent</TableHead>
              <TableHead className="w-52 text-xs uppercase">To</TableHead>
              <TableHead className="text-xs uppercase">Message</TableHead>
              <TableHead className="w-28 text-xs uppercase">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {messages.data!.map((row) => (
              <TableRow key={row.id} className="cursor-pointer" onClick={() => navigate(`/messages/batches/${row.batch_id}`)}>
                <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(row.created_at)}</TableCell>
                <TableCell className="truncate">{row.display_name ?? (row.client_id ? clientById.get(row.client_id)?.display_name : null) ?? '—'}</TableCell>
                <TableCell className="max-w-[30rem] truncate">{row.body?.trim() || (row.media_path ? 'Image' : 'Message')}</TableCell>
                <TableCell>
                  <RecipientStatusBadge status={row.status} />
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
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono">{m.matter_number}</span>
              <MatterStatusBadge status={m.status} />
              {m.practice_area && <span>· {m.practice_area}</span>}
            </div>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{m.title}</h1>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>Opened {formatDate(m.opened_on)}</span>
              {m.closed_on && <span>Closed {formatDate(m.closed_on)}</span>}
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-3.5" /> {people.length} {people.length === 1 ? 'person' : 'people'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ListChecks className="size-3.5" /> {openTasks} open {openTasks === 1 ? 'task' : 'tasks'}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => create.editMatter(m)}>
              <Pencil /> Edit
            </Button>
            <Button variant="outline" onClick={() => create.newTask({ matterId })}>
              <Plus /> New task
            </Button>
            <Button disabled={sendableIds.length === 0} onClick={() => navigate(`/messages/new?to=${sendableIds.join(',')}`)} title={sendableIds.length === 0 ? 'No linked client can be messaged' : undefined}>
              <MessageSquare /> Send message
            </Button>
            {canManage && (
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} aria-label="Delete matter">
                <Trash2 />
              </Button>
            )}
          </div>
        </div>
      </div>

      <DetailTabs
        tabs={[
          { value: 'overview', label: 'Overview', content: overview },
          { value: 'people', label: <>People<TabCount n={links.data ? people.length : undefined} /></>, content: peopleTab },
          {
            value: 'tasks',
            label: <>Tasks &amp; deadlines<TabCount n={tasks.data ? openTasks : undefined} /></>,
            content: (
              <div className="flex flex-col gap-3">
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => create.newTask({ matterId })}>
                    <Plus /> New task
                  </Button>
                </div>
                {tasks.isLoading ? <TableSkeleton rows={3} /> : <TaskTable groups={groups} members={members.data ?? []} showMatter={false} onOpen={create.editTask} emptyText="No tasks for this matter." />}
              </div>
            ),
          },
          { value: 'messages', label: 'Messages', content: messagesTab },
          { value: 'notes', label: 'Notes', content: <NotesEditor label="Matter notes" value={m.notes} onSave={async (notes) => { await updateMatter(supabase, orgId, m.id, { notes }); await invalidate(); }} /> },
        ]}
      />

      <LinkClientDialog
        open={linking}
        onOpenChange={setLinking}
        clients={(clients.data ?? []).filter((c) => !peopleIds.includes(c.id))}
        onLink={async (clientId: string, role: MatterClientRole) => {
          const ok = await run(() => linkClientToMatter(supabase, orgId, matterId, clientId, role), 'Client linked');
          if (ok) setLinking(false);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${m.title}?`}
        description="The matter and its client links are removed. Its tasks stay, without a matter."
        confirmLabel="Delete matter"
        destructive
        busy={busy}
        onConfirm={async () => {
          const ok = await run(() => deleteMatter(supabase, orgId, m.id), 'Matter deleted');
          if (ok) {
            setConfirmDelete(false);
            navigate('/matters', { replace: true });
          }
        }}
      />
    </>
  );
}
