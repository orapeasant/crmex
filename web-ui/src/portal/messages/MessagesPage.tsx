import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Image as ImageIcon, MessageSquare, Plus, RefreshCw, Smartphone } from 'lucide-react';
import { formatDateTime, memberLabel, useApp, type HistoryEntry } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { DataTable } from '../components/DataTable';
import { EmptyState, ErrorState, PageBody, PageHeader, StatusBadge, TableSkeleton } from '../components/common';
import { NONE, SimpleSelect } from '../components/form';
import { useHistory } from '../lib/queries';
import { JobStatusBadge } from './badges';

export function MessagesPage() {
  const { user } = useApp();
  const navigate = useNavigate();
  const history = useHistory();
  const [params, setParams] = useSearchParams();
  const sender = params.get('sender') ?? NONE;

  const members = history.data?.members ?? [];
  const senderName = (id: string | null) => (id === user.id ? 'You' : memberLabel(members.find((m) => m.user_id === id), 'Former member'));
  const entries = useMemo(() => (history.data?.entries ?? []).filter((e) => sender === NONE || (sender === 'me' ? e.senderId === user.id : e.senderId === sender)), [history.data, sender, user.id]);
  const waiting = (history.data?.entries ?? []).filter((e) => e.jobStatus === 'queued' || e.jobStatus === 'claimed').length;

  const columns = useMemo<ColumnDef<HistoryEntry, any>[]>(
    () => [
      { id: 'when', accessorKey: 'when', header: 'Date', meta: { className: 'w-44' }, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatDateTime(row.original.when)}</span> },
      {
        id: 'body',
        accessorFn: (e) => e.body ?? '',
        header: 'Message',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex max-w-[34rem] items-center gap-2">
            {row.original.hasMedia && <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Has image" />}
            <span className="truncate">{row.original.body?.trim() || (row.original.hasMedia ? 'Image' : 'Message')}</span>
          </div>
        ),
      },
      { id: 'sender', accessorFn: (e) => senderName(e.senderId), header: 'Sent by', meta: { className: 'hidden lg:table-cell w-44' } },
      { id: 'recipients', accessorKey: 'total', header: 'Recipients', meta: { className: 'w-28' }, cell: ({ getValue }) => <span className="tabular-nums">{getValue()}</span> },
      {
        id: 'status',
        accessorFn: (e) => e.jobStatus ?? (e.failed ? 'failed' : 'sent'),
        header: 'Status',
        meta: { className: 'w-56' },
        cell: ({ row }) => {
          const e = row.original;
          if (e.jobStatus && e.jobStatus !== 'done') return <JobStatusBadge status={e.jobStatus} />;
          return (
            <div className="flex items-center gap-1.5">
              <StatusBadge tone={e.failed ? 'danger' : 'success'}>
                {e.sent}/{e.total} sent
              </StatusBadge>
              {e.failed > 0 && <span className="text-xs text-red-700 dark:text-red-300">{e.failed} failed</span>}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, user.id],
  );

  return (
    <>
      <PageHeader
        title="Messages"
        description="WhatsApp messages sent by everyone in the firm"
        actions={
          <>
            <Button variant="outline" onClick={() => void history.refetch()} disabled={history.isFetching}>
              <RefreshCw className={history.isFetching ? 'animate-spin' : undefined} /> Refresh
            </Button>
            <Button onClick={() => navigate('/messages/new')}>
              <Plus /> New message
            </Button>
          </>
        }
      />
      <PageBody>
        {waiting > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm text-sky-900 dark:text-sky-300">
            <Smartphone className="size-4 shrink-0" />
            <span>
              {waiting} {waiting === 1 ? 'message is' : 'messages are'} waiting for a phone. Messages queued from the web are sent by the sender's own phone while Leagentex is open on it with WhatsApp linked.
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SimpleSelect
            className="w-52 bg-card"
            value={sender}
            onChange={(v) => {
              const next = new URLSearchParams(params);
              if (v === NONE) next.delete('sender');
              else next.set('sender', v);
              setParams(next, { replace: true });
            }}
            options={[{ value: NONE, label: 'Everyone' }, { value: 'me', label: 'Sent by me' }, ...members.filter((m) => m.user_id !== user.id).map((m) => ({ value: m.user_id, label: memberLabel(m) }))]}
          />
        </div>
        {history.isLoading && <TableSkeleton />}
        {history.isError && <ErrorState error={history.error} onRetry={() => void history.refetch()} title="Couldn't load message history" />}
        {history.data && history.data.entries.length === 0 && (
          <EmptyState
            icon={<MessageSquare />}
            title="No messages yet"
            text="Compose a message, pick clients, and your phone sends it from your WhatsApp account."
            action={
              <Button onClick={() => navigate('/messages/new')}>
                <Plus /> New message
              </Button>
            }
          />
        )}
        {history.data && history.data.entries.length > 0 && (
          <DataTable columns={columns} data={entries} getRowId={(e) => e.id} onRowClick={(e) => navigate(`/messages/batches/${e.id}`)} initialSorting={[{ id: 'when', desc: true }]} resetKey={sender} empty="No messages from this sender." />
        )}
      </PageBody>
    </>
  );
}
