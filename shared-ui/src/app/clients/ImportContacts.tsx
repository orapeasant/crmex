import { useMemo, useState } from 'react';
import { listClients, importClients } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { Avatar, initialsFor } from '../ui/Avatar.js';
import { ErrorCard, LoadingCard, ScreenHeader } from '../ui/components.js';
import { resolveAppRegion } from '../ui/region.js';
import { SearchIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError } from '../ui/util.js';

/** Multi-select from the phone's address book into firm clients (Android only). */
export function ImportContacts() {
  const { supabase, platform } = useApp();
  const { orgId, bump } = useActiveFirm();
  const nav = useNav();

  const data = useAsync(async () => {
    if (!platform.contacts) throw new Error('Phone contacts are not available on this device.');
    const region = await resolveAppRegion(platform);
    const [book, clients] = await Promise.all([platform.contacts.listContacts(region), listClients(supabase, orgId)]);
    const unique = Array.from(new Map(book.usable.map((c) => [c.id, c])).values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { contacts: unique, hidden: book.needsReview.length, existing: new Set(clients.map((c) => c.phone_e164).filter((p): p is string => Boolean(p))) };
  }, [platform, supabase, orgId]);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const visible = useMemo(() => {
    const all = data.data?.contacts ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const digits = q.replace(/[^0-9]/g, '');
    return all.filter((c) => c.displayName.toLowerCase().includes(q) || (digits !== '' && c.e164.includes(digits)));
  }, [data.data, query]);

  const selectable = visible.filter((c) => !data.data?.existing.has(c.e164));
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runImport() {
    if (!data.data) return;
    setImporting(true);
    setError(null);
    try {
      const chosen = data.data.contacts.filter((c) => selected.has(c.id));
      const res = await importClients(supabase, orgId, chosen);
      bump();
      const skipped = res.alreadyClients.length + res.duplicates.length;
      setResult(`Added ${res.inserted.length} ${res.inserted.length === 1 ? 'client' : 'clients'}${skipped ? `, skipped ${skipped} already in the firm or duplicated` : ''}.`);
      setSelected(new Set());
      data.reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <ScreenHeader title="Import from phone" onBack={nav.pop} />
      <main className="content content--with-actionbar stack">
        <p className="muted">Choose contacts to add as clients of this firm. Numbers already in the firm are skipped.</p>
        <div className="search">
          <SearchIcon size={18} />
          <input className="input" type="search" placeholder="Search by name or number" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {result && <div className="alert alert--info">{result}</div>}
        {error && <div className="alert alert--error">{error}</div>}
        {data.status === 'loading' && <LoadingCard label="Reading contacts…" />}
        {data.status === 'error' && <ErrorCard error={data.error} onRetry={data.reload} prefix="Couldn't read contacts" />}

        {data.data && (
          <div className="row row--between">
            <span className="muted">{selected.size} selected</span>
            {selectable.length > 0 && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  setSelected((s) => {
                    const next = new Set(s);
                    selectable.forEach((c) => (allSelected ? next.delete(c.id) : next.add(c.id)));
                    return next;
                  })
                }
              >
                {allSelected ? 'Deselect shown' : 'Select shown'}
              </button>
            )}
          </div>
        )}

        {data.data && visible.length === 0 && <div className="card muted" style={{ textAlign: 'center' }}>{query ? 'No contacts match your search.' : 'No contacts with a usable phone number.'}</div>}

        {visible.length > 0 && (
          <ul className="contact-list">
            {visible.map((c) => {
              const exists = data.data?.existing.has(c.e164) ?? false;
              const isSelected = selected.has(c.id);
              return (
                <li key={c.id} className={isSelected ? 'contact-row contact-row--selected' : exists ? 'contact-row contact-row--disabled' : 'contact-row'} onClick={() => !exists && toggle(c.id)}>
                  <Avatar initials={initialsFor(c.displayName)} size={36} variant="contact" />
                  <div className="contact-row__text">
                    <div className="contact-row__name">{c.displayName}</div>
                    <div className="contact-row__phone">{c.e164}</div>
                  </div>
                  {exists ? (
                    <span className="badge badge--neutral">Already a client</span>
                  ) : (
                    <input className="checkbox" type="checkbox" checked={isSelected} aria-label={`Select ${c.displayName}`} onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {data.data && data.data.hidden > 0 && <p className="faint">{data.data.hidden} numbers were skipped because they couldn't be read as valid phone numbers.</p>}
      </main>
      <div className="actionbar">
        <div className="actionbar__inner">
          <button className="btn btn--secondary" onClick={nav.pop}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button className="btn btn--primary" disabled={selected.size === 0 || importing} onClick={runImport}>
            {importing ? <span className="spinner" /> : `Import ${selected.size || ''}`.trim()}
          </button>
        </div>
      </div>
    </>
  );
}
