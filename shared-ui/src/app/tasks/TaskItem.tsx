import { useState } from 'react';
import { memberLabel } from '../../crm/history.js';
import { formatDue } from '../../crm/tasks.js';
import type { OrgMemberRow, TaskRow } from '../../crm/types.js';
import { setTaskDone } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { describeError } from '../ui/util.js';

export function TaskItem({ task, members, matterTitle, onOpen }: { task: TaskRow; members: OrgMemberRow[]; matterTitle?: string; onOpen: () => void }) {
  const { supabase } = useApp();
  const { orgId, bump } = useActiveFirm();
  const [done, setDone] = useState(task.status === 'done');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overdue = !done && task.due_at !== null && new Date(task.due_at).getTime() < Date.now();
  const assignee = task.assignee_id ? members.find((m) => m.user_id === task.assignee_id) : undefined;

  async function toggle() {
    const next = !done;
    setDone(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      await setTaskDone(supabase, orgId, task.id, next);
      bump();
    } catch (err) {
      setDone(!next);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const meta = [
    task.due_at ? formatDue(task.due_at) : null,
    matterTitle,
    task.assignee_id ? memberLabel(assignee, 'Former member') : null,
  ].filter(Boolean);

  return (
    <li className={done ? 'contact-row task-row task-row--done' : 'contact-row task-row'} onClick={onOpen}>
      <input
        className="checkbox checkbox--round"
        type="checkbox"
        checked={done}
        disabled={busy}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onClick={(e) => e.stopPropagation()}
        onChange={toggle}
      />
      <div className="contact-row__text">
        <div className="contact-row__name task-row__title">{task.title}</div>
        {meta.length > 0 && <div className={overdue ? 'contact-row__phone task-row__overdue' : 'contact-row__phone'}>{meta.join(' · ')}</div>}
        {error && <div className="field__error">{error}</div>}
      </div>
      {task.kind !== 'task' && <span className={task.kind === 'hearing' ? 'badge badge--info' : 'badge badge--warning'}>{task.kind === 'hearing' ? 'Hearing' : 'Deadline'}</span>}
    </li>
  );
}
