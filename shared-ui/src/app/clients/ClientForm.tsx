import { useEffect, useState } from 'react';
import { checkClientPhone, parseTags } from '../../crm/clients.js';
import { CLIENT_KINDS, type ClientKind, type ClientRow } from '../../crm/types.js';
import { getClientById, insertClient, updateClient } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { ErrorCard, LoadingCard, ScreenHeader } from '../ui/components.js';
import { useRegion } from '../ui/region.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError } from '../ui/util.js';

export function ClientForm({ id }: { id?: string }) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  const nav = useNav();
  const existing = useAsync(() => (id ? getClientById(supabase, orgId, id) : Promise.resolve(null)), [supabase, orgId, id]);

  return (
    <>
      <ScreenHeader title={id ? 'Edit client' : 'New client'} onBack={nav.pop} />
      {existing.status === 'loading' && (
        <main className="content">
          <LoadingCard />
        </main>
      )}
      {existing.status === 'error' && (
        <main className="content">
          <ErrorCard error={existing.error} onRetry={existing.reload} />
        </main>
      )}
      {existing.status === 'ready' && <ClientFormBody existing={existing.data ?? null} />}
    </>
  );
}

function ClientFormBody({ existing }: { existing: ClientRow | null }) {
  const { supabase, platform } = useApp();
  const { orgId, bump } = useActiveFirm();
  const nav = useNav();
  const region = useRegion(platform);

  const [name, setName] = useState(existing?.display_name ?? '');
  const [kind, setKind] = useState<ClientKind>(existing?.kind ?? 'client');
  const [phone, setPhone] = useState(existing?.phone_e164 ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [optedIn, setOptedIn] = useState(Boolean(existing?.opted_in_at));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedPhone, setTouchedPhone] = useState(false);

  useEffect(() => setError(null), [name, phone, email]);

  const phoneCheck = region ? checkClientPhone(phone, region) : null;
  const emailOk = email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const valid = name.trim().length > 0 && phoneCheck?.ok === true && emailOk;

  async function save() {
    if (!valid || !phoneCheck?.ok) return;
    setSaving(true);
    setError(null);
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
        bump();
        nav.pop();
      } else {
        const row = await insertClient(supabase, orgId, fields);
        bump();
        nav.replace({ name: 'client', id: row.id });
      }
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
            <span className="field__label">Name *</span>
            <input className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Full name or organisation" autoFocus={!existing} />
          </label>
          <label className="field">
            <span className="field__label">Kind</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ClientKind)}>
              {CLIENT_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="card stack">
          <label className="field">
            <span className="field__label">Mobile phone</span>
            <input className="input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => setTouchedPhone(true)} placeholder="+65 9123 4567" />
            {phoneCheck?.ok && phoneCheck.e164 && phoneCheck.e164 !== phone.trim() && <span className="faint">Will be saved as {phoneCheck.e164}</span>}
            {phoneCheck && !phoneCheck.ok && (touchedPhone || existing) && <span className="field__error">{phoneCheck.error}</span>}
            {!phone.trim() && <span className="faint">Needed to message this client on WhatsApp. Numbers without a country code use {region ?? 'your default region'}.</span>}
          </label>
          <label className="field">
            <span className="field__label">Email</span>
            <input className="input" type="email" inputMode="email" autoCapitalize="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            {!emailOk && <span className="field__error">Enter a valid email address.</span>}
          </label>
        </section>

        <section className="card stack">
          <label className="field">
            <span className="field__label">Tags</span>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. family law, vip" />
            <span className="faint">Separate tags with commas.</span>
          </label>
          <label className="field">
            <span className="field__label">Notes</span>
            <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Background, preferences, how they found the firm…" />
          </label>
          <div className="row row--between">
            <div>
              <div>Opted in to messages</div>
              <div className="faint">Record that this client agreed to receive WhatsApp messages.</div>
            </div>
            <button className="switch" role="switch" aria-checked={optedIn} aria-label="Opted in to messages" onClick={() => setOptedIn((v) => !v)} />
          </div>
        </section>

        {error && <div className="alert alert--error">{error}</div>}
      </main>
      <div className="actionbar">
        <div className="actionbar__inner">
          <button className="btn btn--secondary" onClick={nav.pop} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={!valid || saving}>
            {saving ? <span className="spinner" /> : existing ? 'Save changes' : 'Add client'}
          </button>
        </div>
      </div>
    </>
  );
}
