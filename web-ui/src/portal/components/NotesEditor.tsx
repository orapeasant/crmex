import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { describeError } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from './common';

export function NotesEditor({ value, onSave, label }: { value: string | null; onSave: (notes: string) => Promise<unknown>; label: string }) {
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value ?? ''), [value]);
  const dirty = draft !== (value ?? '');

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
      toast.success('Notes saved');
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <Textarea aria-label={label} className="min-h-64 bg-card leading-relaxed" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="No notes yet. Background, instructions, anything the firm should know…" />
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(value ?? '')} disabled={saving}>
            Discard
          </Button>
        )}
        <Button onClick={save} disabled={!dirty || saving}>
          {saving && <Spinner />}
          Save notes
        </Button>
      </div>
    </div>
  );
}
