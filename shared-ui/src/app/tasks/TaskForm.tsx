import { useState } from 'react';
import { memberLabel } from '../../crm/history.js';
import { dueAtFromParts, duePartsFromIso } from '../../crm/tasks.js';
import { TASK_KINDS, type MatterRow, type OrgMemberRow, type TaskKind, type TaskRow } from '../../crm/types.js';
import { deleteTask, getTaskById, insertTask, listMatters, listOrgMemberRows, setTaskDone, updateTask } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { ConfirmSheet, ErrorCard, LoadingCard, ScreenHeader, Segmented } from '../ui/components.js';
import { TrashIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError } from '../ui/util.js';

export function TaskForm({ id, matterId }: { id?: string; matterId?: string }) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  const nav = useNav();
  const data = useAsync(async () => {
    const [task, matters, members] = await Promise.all([id ? getTaskById(supabase, orgId, id) : Promise.resolve(null), listMatters(supabase, orgId), listOrgMemberRows(supabase, orgId).catch(() => [] as OrgMemberRow[])]);
    return { task, matters, members };
  }, [supabase, orgId, id]);

  return (
    <>
      <ScreenHeader title={id ? 'Edit task' : 'New task'} onBack={nav.pop} />
      {data.status === 'loading' && (
        <main className="content">
          <LoadingCard />
        </main>
      )}
      {data.status === 'error' && (
        <main className="content">
          <ErrorCard error={data.error} onRetry={data.reload} />
        </main>
      )}
      {data.status === 'ready' && data.data && (id && !data.data.task ? <main className="content muted">This task no longer exists.</main> : <TaskFormBody existing={data.data.task} matters={data.data.matters} members={data.data.members} defaultMatterId={matterId} />)}
    </>
  );
}

function TaskFormBody({ existing, matters, members, defaultMatterId }: { existing: TaskRow | null; matters: MatterRow[]; members: OrgMemberRow[]; defaultMatterId?: string }) {
  const { supabase } = useApp();
  const { orgId, bump } = useActiveFirm();
  const nav = useNav();
  const initialDue = duePartsFromIso(existing?.due_at ?? null);

  const [title, setTitle] = useState(existing?.title ?? '');
  const [kind, setKind] = useState<TaskKind>(existing?.kind ?? 'task');
  const [date, setDate] = useState(initialDue.date);
  const [time, setTime] = useState(initialDue.time);
  const [matterId, setMatterId] = useState(existing?.matter_id ?? defaultMatterId ?? '');
  const [assigneeId, setAssigneeId] = useState(existing?.assignee_id ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const needsDate = kind !== 'task';
  const valid = title.trim().length > 0 && (!needsDate || date !== '') && (time === '' || date !== '');
  const openMatters = matters.filter((m) => m.status !== 'closed' || m.id === matterId);
  const assigneeGone = assigneeId !== '' && !members.some((m) => m.user_id === assigneeId);

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    const fields = { title, kind, due_at: dueAtFromParts(date, time), matter_id: matterId || null, assignee_id: assigneeId || null, notes };
    try {
      if (existing) await updateTask(supabase, orgId, existing.id, fields);
      else await insertTask(supabase, orgId, fields);
      bump();
      nav.pop();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await fn();
      bump();
      nav.pop();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <main className="content content--with-actionbar stack">
        <section className="card stack">
          <label className="field">
            <span className="field__label">Title *</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. File defence" autoFocus={!existing} />
          </label>
          <div className="field">
            <span className="field__label">Type</span>
            <Segmented label="Type" value={kind} options={TASK_KINDS} onChange={setKind} />
          </div>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Due date{needsDate ? ' *' : ''}</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Time</span>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!date} />
            </label>
          </div>
          <span className="faint">{date && !time ? 'Due by the end of the day.' : needsDate ? `A ${kind} needs a date.` : 'Leave empty for no due date.'}</span>
        </section>

        <section className="card stack">
          <label className="field">
            <span className="field__label">Matter</span>
            <select className="input" value={matterId} onChange={(e) => setMatterId(e.target.value)}>
              <option value="">No matter</option>
              {openMatters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.matter_number} · {m.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Assignee</span>
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {assigneeGone && <option value={assigneeId}>Former member</option>}
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {memberLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Notes</span>
            <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </section>

        {existing && (
          <div className="row">
            <button className="btn btn--secondary" style={{ flex: 1 }} disabled={saving} onClick={() => run(() => setTaskDone(supabase, orgId, existing.id, existing.status !== 'done'))}>
              {existing.status === 'done' ? 'Reopen task' : 'Mark as done'}
            </button>
            <button className="btn btn--secondary btn--danger-text" disabled={saving} onClick={() => setConfirmDelete(true)}>
              <TrashIcon size={18} /> Delete
            </button>
          </div>
        )}
        {error && <div className="alert alert--error">{error}</div>}
      </main>
      <div className="actionbar">
        <div className="actionbar__inner">
          <button className="btn btn--secondary" onClick={nav.pop} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={!valid || saving}>
            {saving ? <span className="spinner" /> : existing ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </div>
      <ConfirmSheet
        open={confirmDelete}
        title="Delete this task?"
        confirmLabel="Delete"
        danger
        busy={saving}
        error={error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => existing && run(() => deleteTask(supabase, orgId, existing.id))}
      />
    </>
  );
}
