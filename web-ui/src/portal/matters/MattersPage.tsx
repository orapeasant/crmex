import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Briefcase, Plus, Search, X } from 'lucide-react';
import { MATTER_STATUSES, formatDate, type MatterRow, type MatterStatus } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable } from '../components/DataTable';
import { EmptyState, ErrorState, PageBody, PageHeader, TableSkeleton } from '../components/common';
import { NONE, SimpleSelect } from '../components/form';
import { useCreateActions } from '../layout/CreateActions';
import { useMatters, useTasks } from '../lib/queries';
import { MatterStatusBadge } from './MatterStatusBadge';

export function MattersPage() {
  const navigate = useNavigate();
  const create = useCreateActions();
  const matters = useMatters();
  const tasks = useTasks();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const status = (params.get('status') ?? 'open') as MatterStatus | 'all';
  const area = params.get('area') ?? NONE;

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (!value || value === NONE || (key === 'status' && value === 'open')) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const all = matters.data ?? [];
  const areas = useMemo(() => Array.from(new Set(all.map((m) => m.practice_area).filter((a): a is string => Boolean(a)))).sort((a, b) => a.localeCompare(b)), [all]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length, open: 0, pending: 0, closed: 0 };
    all.forEach((m) => c[m.status]++);
    return c;
  }, [all]);
  const openTasksByMatter = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks.data ?? []) if (t.matter_id && t.status === 'open') map.set(t.matter_id, (map.get(t.matter_id) ?? 0) + 1);
    return map;
  }, [tasks.data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((m) => (status === 'all' || m.status === status) && (area === NONE || m.practice_area === area) && (!q || m.title.toLowerCase().includes(q) || m.matter_number.toLowerCase().includes(q) || (m.practice_area ?? '').toLowerCase().includes(q)));
  }, [all, query, status, area]);

  const columns = useMemo<ColumnDef<MatterRow, any>[]>(
    () => [
      { id: 'number', accessorKey: 'matter_number', header: 'Number', meta: { className: 'w-32' }, cell: ({ getValue }) => <span className="font-mono text-[13px]">{getValue()}</span> },
      { id: 'title', accessorFn: (m) => m.title.toLowerCase(), header: 'Title', cell: ({ row }) => <span className="block max-w-[26rem] truncate font-medium">{row.original.title}</span> },
      { id: 'area', accessorFn: (m) => m.practice_area ?? '', header: 'Practice area', meta: { className: 'hidden lg:table-cell' }, cell: ({ getValue }) => <span className="text-muted-foreground">{getValue() || '—'}</span> },
      { id: 'status', accessorKey: 'status', header: 'Status', meta: { className: 'w-28' }, cell: ({ row }) => <MatterStatusBadge status={row.original.status} /> },
      { id: 'tasks', accessorFn: (m) => openTasksByMatter.get(m.id) ?? 0, header: 'Open tasks', meta: { className: 'hidden xl:table-cell w-28' }, cell: ({ getValue }) => <span className="tabular-nums text-muted-foreground">{getValue() || '—'}</span> },
      { id: 'opened', accessorKey: 'opened_on', header: 'Opened', meta: { className: 'w-32' }, cell: ({ row }) => <span className="text-muted-foreground tabular-nums">{formatDate(row.original.opened_on)}</span> },
      { id: 'closed', accessorFn: (m) => m.closed_on ?? '', header: 'Closed', meta: { className: 'hidden 2xl:table-cell w-32' }, cell: ({ row }) => <span className="text-muted-foreground tabular-nums">{row.original.closed_on ? formatDate(row.original.closed_on) : '—'}</span> },
    ],
    [openTasksByMatter],
  );

  const anyFilter = Boolean(query.trim()) || status !== 'open' || area !== NONE;

  return (
    <>
      <PageHeader
        title="Matters"
        description={matters.data ? `${counts.open} open · ${counts.pending} pending · ${counts.closed} closed` : 'Cases and engagements'}
        actions={
          <Button onClick={create.newMatter}>
            <Plus /> New matter
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72 xl:w-80">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search matters" placeholder="Search number, title or practice area" value={query} onChange={(e) => setParam('q', e.target.value)} className="bg-card pl-8" />
          </div>
          <SimpleSelect
            className="w-40 bg-card"
            value={status}
            onChange={(v) => setParam('status', v)}
            options={[...MATTER_STATUSES.map((s) => ({ value: s.value as MatterStatus | 'all', label: `${s.label}${matters.data ? ` (${counts[s.value]})` : ''}` })), { value: 'all', label: `All statuses${matters.data ? ` (${counts.all})` : ''}` }]}
          />
          <SimpleSelect className="w-48 bg-card" value={area} onChange={(v) => setParam('area', v)} options={[{ value: NONE, label: 'All practice areas' }, ...areas.map((a) => ({ value: a, label: a }))]} />
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              <X /> Clear
            </Button>
          )}
        </div>
        {matters.isLoading && <TableSkeleton />}
        {matters.isError && <ErrorState error={matters.error} onRetry={() => void matters.refetch()} title="Couldn't load matters" />}
        {matters.data && all.length === 0 && (
          <EmptyState
            icon={<Briefcase />}
            title="No matters yet"
            text="Open a matter to track its clients, deadlines and hearings."
            action={
              <Button onClick={create.newMatter}>
                <Plus /> New matter
              </Button>
            }
          />
        )}
        {matters.data && all.length > 0 && (
          <DataTable columns={columns} data={visible} getRowId={(m) => m.id} onRowClick={(m) => navigate(`/matters/${m.id}`)} initialSorting={[{ id: 'opened', desc: true }]} resetKey={`${query}|${status}|${area}`} empty="No matters match these filters." />
        )}
      </PageBody>
    </>
  );
}
