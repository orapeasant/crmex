import { useState } from 'react';
import { toast } from 'sonner';
import { TASK_KINDS, deleteTask, describeError, dueAtFromParts, duePartsFromIso, insertTask, memberLabel, setTaskDone, updateTask, useActiveFirm, useApp, type TaskKind, type TaskRow } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '../components/common';
import { Field, FormError, NONE, SimpleSelect } from '../components/form';
import { useInvalidateFirm, useMatters, useMemberRows } from '../lib/queries';

export function TaskFormDialog({ open, onOpenChange, existing, matterId }: { open: boolean; onOpenChange: (open: boolean) => void; existing?: TaskRow | null; matterId?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">{open && <TaskFormBody existing={existing ?? null} defaultMatterId={matterId} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function TaskFormBody({ existing, defaultMatterId, onDone }: { existing: TaskRow | null; defaultMatterId?: string; onDone: () => void }) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  const invalidate = useInvalidateFirm();
  const matters = useMatters();
  const members = useMemberRows();
  const initialDue = duePartsFromIso(existing?.due_at ?? null);

  const [title, setTitle] = useState(existing?.title ?? '');
  const [kind, setKind] = useState<TaskKind>(existing?.kind ?? 'task');
  const [date, setDate] = useState(initialDue.date);
  const [time, setTime] = useState(initialDue.time);
  const [matterId, setMatterId] = useState(existing?.matter_id ?? defaultMatterId ?? NONE);
  const [assigneeId, setAssigneeId] = useState(existing?.assignee_id ?? NONE);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const needsDate = kind !== 'task';
  const valid = title.trim().length > 0 && (!needsDate || date !== '') && (time === '' || date !== '');
  const matterOptions = (matters.data ?? []).filter((m) => m.status !== 'closed' || m.id === matterId);
  const memberList = members.data ?? [];
  const assigneeGone = assigneeId !== NONE && members.isSuccess && !memberList.some((m) => m.user_id === assigneeId);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setError(null);
    const fields = { title, kind, due_at: dueAtFromParts(date, time), matter_id: matterId === NONE ? null : matterId, assignee_id: assigneeId === NONE ? null : assigneeId, notes };
    try {
      if (existing) await updateTask(supabase, orgId, existing.id, fields);
      else await insertTask(supabase, orgId, fields);
      toast.success(existing ? 'Task updated' : 'Task created');
      await invalidate();
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function run(fn: () => Promise<unknown>, success: string) {
    setSaving(true);
    setError(null);
    try {
      await fn();
      toast.success(success);
      await invalidate();
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>{existing ? 'Edit task' : 'New task'}</DialogTitle>
        <DialogDescription>To-dos, filing deadlines and hearings, optionally linked to a matter.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="task-title" label="Title" className="sm:col-span-2" error={touched && !title.trim() ? 'Enter a title.' : null}>
          <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. File defence" autoFocus />
        </Field>
        <Field id="task-kind" label="Type">
          <SimpleSelect id="task-kind" value={kind} onChange={setKind} options={TASK_KINDS} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id="task-date" label={needsDate ? 'Due date *' : 'Due date'} error={touched && needsDate && !date ? `A ${kind} needs a date.` : null}>
            <Input id="task-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field id="task-time" label="Time">
            <Input id="task-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!date} />
          </Field>
        </div>
        <Field id="task-matter" label="Matter">
          <SimpleSelect
            id="task-matter"
            value={matterId}
            onChange={setMatterId}
            options={[{ value: NONE, label: 'No matter' }, ...matterOptions.map((m) => ({ value: m.id, label: `${m.matter_number} · ${m.title}` }))]}
          />
        </Field>
        <Field id="task-assignee" label="Assignee">
          <SimpleSelect
            id="task-assignee"
            value={assigneeId}
            onChange={setAssigneeId}
            options={[{ value: NONE, label: 'Unassigned' }, ...(assigneeGone ? [{ value: assigneeId, label: 'Former member' }] : []), ...memberList.map((m) => ({ value: m.user_id, label: memberLabel(m) }))]}
          />
        </Field>
        <Field id="task-notes" label="Notes" className="sm:col-span-2">
          <Textarea id="task-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <FormError error={error} />
      <DialogFooter>
        {existing && (
          <div className="mr-auto flex gap-2">
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={saving} onClick={() => (confirmDelete ? void run(() => deleteTask(supabase, orgId, existing.id), 'Task deleted') : setConfirmDelete(true))}>
              {confirmDelete ? 'Confirm delete' : 'Delete'}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={() => void run(() => setTaskDone(supabase, orgId, existing.id, existing.status !== 'done'), existing.status === 'done' ? 'Task reopened' : 'Task completed')}>
              {existing.status === 'done' ? 'Reopen' : 'Mark done'}
            </Button>
          </div>
        )}
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || (touched && !valid)}>
          {saving && <Spinner />}
          {existing ? 'Save changes' : 'Create task'}
        </Button>
      </DialogFooter>
    </form>
  );
}
