import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { MATTER_STATUSES, describeError, insertMatter, todayIsoDate, updateMatter, useActiveFirm, useApp, type MatterRow, type MatterStatus } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '../components/common';
import { Field, FormError, SimpleSelect } from '../components/form';
import { useInvalidateFirm } from '../lib/queries';

export function MatterFormDialog({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (open: boolean) => void; existing?: MatterRow | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">{open && <MatterFormBody existing={existing ?? null} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function MatterFormBody({ existing, onDone }: { existing: MatterRow | null; onDone: () => void }) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  const invalidate = useInvalidateFirm();
  const navigate = useNavigate();
  const [number, setNumber] = useState(existing?.matter_number ?? '');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [area, setArea] = useState(existing?.practice_area ?? '');
  const [status, setStatus] = useState<MatterStatus>(existing?.status ?? 'open');
  const [openedOn, setOpenedOn] = useState(existing?.opened_on ?? todayIsoDate());
  const [closedOn, setClosedOn] = useState(existing?.closed_on ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const datesOk = !closedOn || !openedOn || closedOn >= openedOn;
  const valid = Boolean(number.trim() && title.trim() && openedOn && datesOk);

  function changeStatus(next: MatterStatus) {
    setStatus(next);
    if (next === 'closed' && !closedOn) setClosedOn(todayIsoDate());
    if (next !== 'closed') setClosedOn('');
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setError(null);
    const fields = { matter_number: number, title, practice_area: area, status, opened_on: openedOn, closed_on: closedOn || null, notes };
    try {
      if (existing) {
        await updateMatter(supabase, orgId, existing.id, fields);
        toast.success('Matter updated');
      } else {
        const row = await insertMatter(supabase, orgId, fields);
        toast.success(`Matter ${row.matter_number} opened`);
        navigate(`/matters/${row.id}`);
      }
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
        <DialogTitle>{existing ? 'Edit matter' : 'New matter'}</DialogTitle>
        <DialogDescription>A case or engagement, with its clients, deadlines and hearings.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="matter-number" label="Matter number" error={touched && !number.trim() ? 'Enter a matter number.' : null}>
          <Input id="matter-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="2026-014" autoFocus />
        </Field>
        <Field id="matter-status" label="Status">
          <SimpleSelect id="matter-status" value={status} onChange={changeStatus} options={MATTER_STATUSES} />
        </Field>
        <Field id="matter-title" label="Title" className="sm:col-span-2" error={touched && !title.trim() ? 'Enter a title.' : null}>
          <Input id="matter-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Estate of Lim Ah Kow" />
        </Field>
        <Field id="matter-area" label="Practice area" className="sm:col-span-2">
          <Input id="matter-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Probate, Family, Conveyancing…" />
        </Field>
        <Field id="matter-opened" label="Opened on">
          <Input id="matter-opened" type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
        </Field>
        <Field id="matter-closed" label="Closed on" error={!datesOk ? "Can't be before the opening date." : null}>
          <Input id="matter-closed" type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} />
        </Field>
        <Field id="matter-notes" label="Notes" className="sm:col-span-2">
          <Textarea id="matter-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <FormError error={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || (touched && !valid)}>
          {saving && <Spinner />}
          {existing ? 'Save changes' : 'Create matter'}
        </Button>
      </DialogFooter>
    </form>
  );
}
