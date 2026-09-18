import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { ListChecks, Plus, X } from 'lucide-react';
import { TASK_KINDS, groupTasks, memberLabel, useApp, type TaskKind } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { EmptyState, ErrorState, PageBody, PageHeader, TableSkeleton } from '../components/common';
import { NONE, SimpleSelect } from '../components/form';
import { useCreateActions } from '../layout/CreateActions';
import { useMatters, useMemberRows, useTasks } from '../lib/queries';
import { TaskTable, type TaskGroup } from './TaskTable';

type StatusFilter = 'open' | 'done' | 'all';
type DueFilter = typeof NONE | 'overdue' | 'today' | 'week' | 'month';

const DAY = 86_400_000;

export function TasksPage() {
  const { user } = useApp();
  const create = useCreateActions();
  const tasks = useTasks();
  const matters = useMatters();
  const members = useMemberRows();
  const [params, setParams] = useSearchParams();

  const status = (params.get('status') ?? 'open') as StatusFilter;
  const kind = (params.get('kind') ?? NONE) as TaskKind | typeof NONE;
  const assignee = params.get('assignee') ?? NONE;
  const due = (params.get('due') ?? NONE) as DueFilter;
  const mine = params.get('mine') === '1';

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null || value === NONE || (key === 'status' && value === 'open')) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  const filtered = useMemo(() => {
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    return (tasks.data ?? []).filter((t) => {
      if (status !== 'all' && t.status !== status) return false;
      if (kind !== NONE && t.kind !== kind) return false;
      if (mine && t.assignee_id !== user.id) return false;
      if (!mine && assignee !== NONE && (assignee === 'unassigned' ? t.assignee_id !== null : t.assignee_id !== assignee)) return false;
      if (due !== NONE) {
        if (!t.due_at) return false;
        const d = new Date(t.due_at).getTime();
        if (due === 'overdue' && !(d < now.getTime() && t.status === 'open')) return false;
        if (due === 'today' && !(d <= endOfToday.getTime() && d >= endOfToday.getTime() - DAY + 1)) return false;
        if (due === 'week' && !(d >= now.getTime() - DAY && d <= now.getTime() + 7 * DAY)) return false;
        if (due === 'month' && !(d >= now.getTime() - DAY && d <= now.getTime() + 30 * DAY)) return false;
      }
      return true;
    });
  }, [tasks.data, status, kind, assignee, due, mine, user.id]);

  const groups = useMemo<TaskGroup[]>(() => {
    const s = groupTasks(filtered);
    return [
      { key: 'overdue', label: 'Overdue', tone: 'danger', tasks: s.overdue },
      { key: 'today', label: 'Today', tasks: s.today },
      { key: 'upcoming', label: 'Upcoming', tasks: s.upcoming },
      { key: 'nodate', label: 'No date', tasks: s.noDate },
      { key: 'done', label: 'Done', tasks: s.done.slice(0, 200) },
    ];
  }, [filtered]);

  const all = tasks.data ?? [];
  const openCount = all.filter((t) => t.status === 'open').length;
  const overdueCount = all.filter((t) => t.status === 'open' && t.due_at && new Date(t.due_at).getTime() < Date.now()).length;
  const anyFilter = status !== 'open' || kind !== NONE || assignee !== NONE || due !== NONE || mine;

  return (
    <>
      <PageHeader
        title="Tasks"
        description={tasks.data ? `${openCount} open${overdueCount ? ` · ${overdueCount} overdue` : ''}` : 'To-dos, filing deadlines and hearings'}
        actions={
          <Button onClick={() => create.newTask()}>
            <Plus /> New task
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <SimpleSelect
            className="w-36 bg-card"
            value={status}
            onChange={(v) => setParam('status', v)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'done', label: 'Done' },
              { value: 'all', label: 'All statuses' },
            ]}
          />
          <SimpleSelect className="w-36 bg-card" value={kind} onChange={(v) => setParam('kind', v)} options={[{ value: NONE, label: 'All types' }, ...TASK_KINDS]} />
          <SimpleSelect
            className="w-44 bg-card"
            value={mine ? NONE : assignee}
            onChange={(v) => setParam('assignee', v)}
            options={[{ value: NONE, label: 'Any assignee' }, { value: 'unassigned', label: 'Unassigned' }, ...(members.data ?? []).map((m) => ({ value: m.user_id, label: m.user_id === user.id ? `${memberLabel(m)} (you)` : memberLabel(m) }))]}
          />
          <SimpleSelect
            className="w-40 bg-card"
            value={due}
            onChange={(v) => setParam('due', v)}
            options={[
              { value: NONE, label: 'Any due date' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'today', label: 'Due today' },
              { value: 'week', label: 'Next 7 days' },
              { value: 'month', label: 'Next 30 days' },
            ]}
          />
          <label className="ml-1 flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm">
            <Switch checked={mine} onCheckedChange={(v) => setParam('mine', v ? '1' : null)} aria-label="My tasks" />
            My tasks
          </label>
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              <X /> Clear
            </Button>
          )}
        </div>

        {tasks.isLoading && <TableSkeleton />}
        {tasks.isError && <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} title="Couldn't load tasks" />}
        {tasks.data && all.length === 0 && (
          <EmptyState
            icon={<ListChecks />}
            title="No tasks yet"
            text="Track to-dos, filing deadlines and hearings, optionally linked to a matter."
            action={
              <Button onClick={() => create.newTask()}>
                <Plus /> New task
              </Button>
            }
          />
        )}
        {tasks.data && all.length > 0 && <TaskTable groups={groups} members={members.data ?? []} matters={matters.data} onOpen={create.editTask} emptyText={mine ? 'Nothing assigned to you matches.' : 'No tasks match these filters.'} />}
      </PageBody>
    </>
  );
}
