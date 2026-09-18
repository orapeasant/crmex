import { useState } from 'react';
import { MATTER_STATUSES, type MatterRow, type MatterStatus } from '../../crm/types.js';
import { getMatterById, insertMatter, updateMatter } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { ErrorCard, LoadingCard, ScreenHeader } from '../ui/components.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError, todayIsoDate } from '../ui/util.js';

export function MatterForm({ id }: { id?: string }) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  const nav = useNav();
  const existing = useAsync(() => (id ? getMatterById(supabase, orgId, id) : Promise.resolve(null)), [supabase, orgId, id]);
  return (
    <>
      <ScreenHeader title={id ? 'Edit matter' : 'New matter'} onBack={nav.pop} />
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
      {existing.status === 'ready' && <MatterFormBody existing={existing.data ?? null} />}
    </>
  );
}

function MatterFormBody({ existing }: { existing: MatterRow | null }) {
  const { supabase } = useApp();
  const { orgId, bump } = useActiveFirm();
  const nav = useNav();
  const [number, setNumber] = useState(existing?.matter_number ?? '');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [area, setArea] = useState(existing?.practice_area ?? '');
  const [status, setStatus] = useState<MatterStatus>(existing?.status ?? 'open');
  const [openedOn, setOpenedOn] = useState(existing?.opened_on ?? todayIsoDate());
  const [closedOn, setClosedOn] = useState(existing?.closed_on ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const datesOk = !closedOn || !openedOn || closedOn >= openedOn;
  const valid = number.trim() && title.trim() && openedOn && datesOk;

  function changeStatus(next: MatterStatus) {
    setStatus(next);
    if (next === 'closed' && !closedOn) setClosedOn(todayIsoDate());
    if (next !== 'closed') setClosedOn('');
  }

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    const fields = { matter_number: number, title, practice_area: area, status, opened_on: openedOn, closed_on: closedOn || null, notes };
    try {
      if (existing) {
        await updateMatter(supabase, orgId, existing.id, fields);
        bump();
        nav.pop();
      } else {
        const row = await insertMatter(supabase, orgId, fields);
        bump();
        nav.replace({ name: 'matter', id: row.id });
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
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Matter number *</span>
              <input className="input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="2026-014" autoFocus={!existing} />
            </label>
            <label className="field">
              <span className="field__label">Status</span>
              <select className="input" value={status} onChange={(e) => changeStatus(e.target.value as MatterStatus)}>
                {MATTER_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field__label">Title *</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Estate of Lim Ah Kow" />
          </label>
          <label className="field">
            <span className="field__label">Practice area</span>
            <input className="input" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Probate, Family, Conveyancing" />
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Opened on *</span>
              <input className="input" type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Closed on</span>
              <input className="input" type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} />
            </label>
          </div>
          {!datesOk && <span className="field__error">The closing date can't be before the opening date.</span>}
          <label className="field">
            <span className="field__label">Notes</span>
            <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </section>
        {error && <div className="alert alert--error">{error}</div>}
      </main>
      <div className="actionbar">
        <div className="actionbar__inner">
          <button className="btn btn--secondary" onClick={nav.pop} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={!valid || saving}>
            {saving ? <span className="spinner" /> : existing ? 'Save changes' : 'Create matter'}
          </button>
        </div>
      </div>
    </>
  );
}
