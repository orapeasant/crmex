import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CLIENT_KINDS, checkClientPhone, describeError, insertClient, parseTags, updateClient, useActiveFirm, useApp, useRegion, type ClientKind, type ClientRow } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '../components/common';
import { Field, FormError, SimpleSelect } from '../components/form';
import { useInvalidateFirm } from '../lib/queries';

export function ClientFormDialog({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (open: boolean) => void; existing?: ClientRow | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">{open && <ClientFormBody existing={existing ?? null} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ClientFormBody({ existing, onDone }: { existing: ClientRow | null; onDone: () => void }) {
  const { supabase, platform } = useApp();
  const { orgId } = useActiveFirm();
  const invalidate = useInvalidateFirm();
  const navigate = useNavigate();
  const region = useRegion(platform);

  const [name, setName] = useState(existing?.display_name ?? '');
  const [kind, setKind] = useState<ClientKind>(existing?.kind ?? 'client');
  const [phone, setPhone] = useState(existing?.phone_e164 ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [optedIn, setOptedIn] = useState(Boolean(existing?.opted_in_at));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [name, phone, email]);

  const phoneCheck = region ? checkClientPhone(phone, region) : null;
  const emailOk = email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const valid = name.trim().length > 0 && phoneCheck?.ok === true && emailOk;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || !phoneCheck?.ok) return;
    setSaving(true);
    const fields = {
      display_name: name,
      kind,
      phone_e164: phoneCheck.e164,
      email,
      tags: parseTags(tags),
      notes,
      opted_in_at: optedIn ? (existing?.opted_in_at ?? new Date().toISOString()) : null,
    };
    try {
      if (existing) {
        await updateClient(supabase, orgId, existing.id, fields);
        toast.success('Client updated');
      } else {
        const row = await insertClient(supabase, orgId, fields);
        toast.success(`${row.display_name} added`);
        navigate(`/clients/${row.id}`);
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
        <DialogTitle>{existing ? 'Edit client' : 'New client'}</DialogTitle>
        <DialogDescription>People and organisations your firm works with.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="client-name" label="Name" className="sm:col-span-2" error={touched && !name.trim() ? 'Enter a name.' : null}>
          <Input id="client-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Full name or organisation" autoFocus aria-invalid={touched && !name.trim()} />
        </Field>
        <Field id="client-kind" label="Kind">
          <SimpleSelect id="client-kind" value={kind} onChange={setKind} options={CLIENT_KINDS} />
        </Field>
        <Field
          id="client-phone"
          label="Mobile phone"
          error={phoneCheck && !phoneCheck.ok && (touched || existing) ? phoneCheck.error : null}
          hint={phoneCheck?.ok && phoneCheck.e164 && phoneCheck.e164 !== phone.trim() ? `Saved as ${phoneCheck.e164}` : `Needed for WhatsApp. Default region: ${region ?? '…'}`}
        >
          <Input id="client-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => setTouched(true)} placeholder="+65 9123 4567" />
        </Field>
        <Field id="client-email" label="Email" error={!emailOk ? 'Enter a valid email address.' : null}>
          <Input id="client-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </Field>
        <Field id="client-tags" label="Tags" hint="Separate tags with commas.">
          <Input id="client-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="family law, vip" />
        </Field>
        <Field id="client-notes" label="Notes" className="sm:col-span-2">
          <Textarea id="client-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Background, preferences, how they found the firm…" />
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5 sm:col-span-2">
          <div>
            <label htmlFor="client-optin" className="text-sm font-medium">
              Opted in to messages
            </label>
            <p className="text-xs text-muted-foreground">Record that this client agreed to receive WhatsApp messages.</p>
          </div>
          <Switch id="client-optin" checked={optedIn} onCheckedChange={setOptedIn} />
        </div>
      </div>

      <FormError error={error} />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || (touched && !valid)}>
          {saving && <Spinner />}
          {existing ? 'Save changes' : 'Add client'}
        </Button>
      </DialogFooter>
    </form>
  );
}
