import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { Ban, MessageSquare, Plus, Search, Users, X } from 'lucide-react';
import { CLIENT_KINDS, clientKindLabel, collectTags, filterClients, formatDate, type ClientKind, type ClientRow } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable } from '../components/DataTable';
import { EmptyState, ErrorState, Initials, PageBody, PageHeader, StatusBadge, TableSkeleton } from '../components/common';
import { NONE, SimpleSelect } from '../components/form';
import { useCreateActions } from '../layout/CreateActions';
import { useClients } from '../lib/queries';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export function ClientsPage() {
  const navigate = useNavigate();
  const create = useCreateActions();
  const clients = useClients();
  // Filters live in the URL so a refresh or a shared link keeps them.
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const kind = (params.get('kind') ?? NONE) as ClientKind | typeof NONE;
  const tag = params.get('tag') ?? NONE;
  const [selection, setSelection] = useState<RowSelectionState>({});

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (!value || value === NONE) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const all = clients.data ?? [];
  const tags = useMemo(() => collectTags(all), [all]);
  const visible = useMemo(() => filterClients(all, { query, kind: kind === NONE ? null : kind, tag: tag === NONE ? null : tag }), [all, query, kind, tag]);
  const filtered = Boolean(query.trim() || kind !== NONE || tag !== NONE);

  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const sendable = all.filter((c) => selection[c.id] && !c.suppressed_at && c.phone_e164 && E164.test(c.phone_e164));

  const columns = useMemo<ColumnDef<ClientRow, any>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (c) => c.display_name.toLowerCase(),
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Initials name={row.original.display_name} />
            <div className="min-w-0">
              <div className="truncate font-medium">{row.original.display_name}</div>
              <div className="truncate text-xs text-muted-foreground xl:hidden">{row.original.email ?? ''}</div>
            </div>
          </div>
        ),
      },
      { id: 'kind', accessorFn: (c) => clientKindLabel(c.kind), header: 'Kind', cell: ({ getValue }) => <span className="text-muted-foreground">{getValue()}</span> },
      { id: 'phone', accessorFn: (c) => c.phone_e164 ?? '', header: 'Phone', cell: ({ getValue }) => <span className="font-mono text-[13px] tabular-nums">{getValue() || '—'}</span> },
      { id: 'email', accessorFn: (c) => c.email ?? '', header: 'Email', meta: { className: 'hidden xl:table-cell' }, cell: ({ getValue }) => <span className="block max-w-[16rem] truncate">{getValue() || '—'}</span> },
      {
        id: 'tags',
        header: 'Tags',
        enableSorting: false,
        meta: { className: 'hidden lg:table-cell' },
        cell: ({ row }) => (
          <div className="flex max-w-[14rem] flex-wrap gap-1">
            {row.original.tags.slice(0, 3).map((t) => (
              <StatusBadge key={t} tone="brand">
                {t}
              </StatusBadge>
            ))}
            {row.original.tags.length > 3 && <span className="text-xs text-muted-foreground">+{row.original.tags.length - 3}</span>}
          </div>
        ),
      },
      {
        id: 'status',
        accessorFn: (c) => (c.suppressed_at ? 1 : 0),
        header: 'Messaging',
        cell: ({ row }) =>
          row.original.suppressed_at ? (
            <StatusBadge tone="warning">
              <Ban className="size-3" /> Opted out
            </StatusBadge>
          ) : row.original.opted_in_at ? (
            <StatusBadge tone="success">Opted in</StatusBadge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      { id: 'added', accessorFn: (c) => c.created_at, header: 'Added', meta: { className: 'hidden 2xl:table-cell' }, cell: ({ row }) => <span className="text-muted-foreground">{formatDate(row.original.created_at)}</span> },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Clients"
        description={clients.data ? (filtered ? `${visible.length} of ${all.length} clients` : `${all.length} ${all.length === 1 ? 'client' : 'clients'}`) : 'People and organisations your firm works with'}
        actions={
          <Button onClick={create.newClient}>
            <Plus /> New client
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72 xl:w-80">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search clients" placeholder="Search name, phone, email or tag" value={query} onChange={(e) => setParam('q', e.target.value)} className="bg-card pl-8" />
          </div>
          <SimpleSelect className="w-44 bg-card" value={kind} onChange={(v) => setParam('kind', v)} options={[{ value: NONE, label: 'All kinds' }, ...CLIENT_KINDS]} />
          <SimpleSelect className="w-44 bg-card" value={tag} onChange={(v) => setParam('tag', v)} options={[{ value: NONE, label: 'All tags' }, ...tags.slice(0, 50).map((t) => ({ value: t, label: t }))]} />
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              <X /> Clear
            </Button>
          )}
        </div>

        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50 dark:bg-teal-950/40 px-4 py-2 text-sm" role="region" aria-label="Bulk actions">
            <span className="font-medium text-teal-900 dark:text-teal-300">{selectedIds.length} selected</span>
            {sendable.length < selectedIds.length && <span className="text-teal-800 dark:text-teal-300">{selectedIds.length - sendable.length} can't be messaged (no mobile number or opted out)</span>}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelection({})}>
                Clear selection
              </Button>
              <Button size="sm" disabled={sendable.length === 0} onClick={() => navigate(`/messages/new?to=${sendable.map((c) => c.id).join(',')}`)}>
                <MessageSquare /> Send message to selected
              </Button>
            </div>
          </div>
        )}

        {clients.isLoading && <TableSkeleton />}
        {clients.isError && <ErrorState error={clients.error} onRetry={() => void clients.refetch()} title="Couldn't load clients" />}
        {clients.data && all.length === 0 && (
          <EmptyState
            icon={<Users />}
            title="No clients yet"
            text="Add the people and organisations your firm works with. Clients imported from a phone in the Leagentex app appear here too."
            action={
              <Button onClick={create.newClient}>
                <Plus /> Add client
              </Button>
            }
          />
        )}
        {clients.data && all.length > 0 && (
          <DataTable
            columns={columns}
            data={visible}
            getRowId={(c) => c.id}
            rowLabel={(c) => c.display_name}
            onRowClick={(c) => navigate(`/clients/${c.id}`)}
            selectable
            selection={selection}
            onSelectionChange={setSelection}
            initialSorting={[{ id: 'name', desc: false }]}
            resetKey={`${query}|${kind}|${tag}`}
            empty="No clients match these filters."
          />
        )}
      </PageBody>
    </>
  );
}
