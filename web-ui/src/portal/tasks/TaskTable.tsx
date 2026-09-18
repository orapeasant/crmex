import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { describeError, formatDue, memberLabel, setTaskDone, useActiveFirm, useApp, type MatterRow, type OrgMemberRow, type TaskRow } from 'shared-ui';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '../components/common';
import { useInvalidateFirm } from '../lib/queries';

export interface TaskGroup {
  key: string;
  label: string;
  tone?: 'danger';
  tasks: TaskRow[];
}

export function KindBadge({ kind }: { kind: TaskRow['kind'] }) {
  if (kind === 'hearing') return <StatusBadge tone="info">Hearing</StatusBadge>;
  if (kind === 'deadline') return <StatusBadge tone="warning">Deadline</StatusBadge>;
  return <StatusBadge>Task</StatusBadge>;
}

function TaskDoneCheckbox({ task }: { task: TaskRow }) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  const invalidate = useInvalidateFirm();
  const [done, setDone] = useState(task.status === 'done');
  const [busy, setBusy] = useState(false);

  async function toggle(next: boolean) {
    setDone(next); // optimistic
    setBusy(true);
    try {
      await setTaskDone(supabase, orgId, task.id, next);
      toast.success(next ? `Completed “${task.title}”` : `Reopened “${task.title}”`);
      await invalidate();
    } catch (err) {
      setDone(!next);
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Checkbox
      className="rounded-full"
      checked={done}
      disabled={busy}
      aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      onClick={(e) => e.stopPropagation()}
      onCheckedChange={(v) => void toggle(Boolean(v))}
    />
  );
}

export function TaskTable({ groups, members, matters, onOpen, showMatter = true, emptyText = 'No tasks.' }: { groups: TaskGroup[]; members: OrgMemberRow[]; matters?: MatterRow[]; onOpen: (t: TaskRow) => void; showMatter?: boolean; emptyText?: string }) {
  const matterById = new Map((matters ?? []).map((m) => [m.id, m]));
  const nonEmpty = groups.filter((g) => g.tasks.length > 0);
  const cols = showMatter ? 6 : 5;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">
                <span className="sr-only">Done</span>
              </TableHead>
              <TableHead className="text-xs uppercase tracking-wide">Task</TableHead>
              <TableHead className="w-28 text-xs uppercase tracking-wide">Type</TableHead>
              <TableHead className="w-40 text-xs uppercase tracking-wide">Due</TableHead>
              {showMatter && <TableHead className="hidden text-xs uppercase tracking-wide lg:table-cell">Matter</TableHead>}
              <TableHead className="hidden w-44 text-xs uppercase tracking-wide md:table-cell">Assignee</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nonEmpty.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={cols} className="h-32 text-center text-sm text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
            {nonEmpty.map((g) => (
              <GroupRows key={g.key} group={g} cols={cols} members={members} matterById={matterById} onOpen={onOpen} showMatter={showMatter} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function GroupRows({ group, cols, members, matterById, onOpen, showMatter }: { group: TaskGroup; cols: number; members: OrgMemberRow[]; matterById: Map<string, MatterRow>; onOpen: (t: TaskRow) => void; showMatter: boolean }) {
  return (
    <>
      {group.label && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={cols} className={cn('py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground', group.tone === 'danger' && 'text-red-700 dark:text-red-300')}>
            {group.label} <span className="font-normal">· {group.tasks.length}</span>
          </TableCell>
        </TableRow>
      )}
      {group.tasks.map((t) => {
        const done = t.status === 'done';
        const overdue = !done && t.due_at !== null && new Date(t.due_at).getTime() < Date.now();
        const matter = t.matter_id ? matterById.get(t.matter_id) : undefined;
        const assignee = t.assignee_id ? members.find((m) => m.user_id === t.assignee_id) : undefined;
        return (
          <TableRow key={`${t.id}:${t.status}`} className="cursor-pointer" tabIndex={0} onClick={() => onOpen(t)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(t)}>
            <TableCell className="py-2.5">
              <TaskDoneCheckbox task={t} />
            </TableCell>
            <TableCell className="max-w-[28rem] py-2.5">
              <div className={cn('truncate font-medium', done && 'text-muted-foreground line-through')}>{t.title}</div>
              {t.notes && <div className="truncate text-xs text-muted-foreground">{t.notes}</div>}
            </TableCell>
            <TableCell className="py-2.5">
              <KindBadge kind={t.kind} />
            </TableCell>
            <TableCell className={cn('py-2.5 tabular-nums', overdue ? 'font-medium text-red-700 dark:text-red-300' : 'text-muted-foreground')}>{formatDue(t.due_at)}</TableCell>
            {showMatter && (
              <TableCell className="hidden max-w-[18rem] py-2.5 lg:table-cell">
                {matter ? (
                  <Link to={`/matters/${matter.id}`} onClick={(e) => e.stopPropagation()} className="block truncate hover:underline">
                    <span className="font-mono text-xs text-muted-foreground">{matter.matter_number}</span> {matter.title}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            )}
            <TableCell className="hidden py-2.5 text-muted-foreground md:table-cell">{t.assignee_id ? memberLabel(assignee, 'Former member') : 'Unassigned'}</TableCell>
          </TableRow>
        );
      })}
    </>
  );
}
