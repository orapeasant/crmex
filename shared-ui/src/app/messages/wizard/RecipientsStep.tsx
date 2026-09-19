import { useMemo, useState } from 'react';
import type { RecipientContact } from '../../../crm/clients.js';
import { Avatar, initialsFor } from '../../ui/Avatar.js';
import { CloseIcon, SearchIcon } from '../../ui/icons.js';

export interface ContactsState {
  status: 'loading' | 'ready' | 'error';
  contacts: RecipientContact[];
  /** Clients left out because they opted out of messages. */
  suppressedCount: number;
  /** Clients left out because they have no usable phone number. */
  noPhoneCount: number;
  /** Clients left out because they are not `active` (§18.3.1) — inactive or archived, never offered at all. */
  inactiveCount: number;
  error?: string;
}

export interface RecipientsStepProps {
  contactsState: ContactsState;
  selectedIds: ReadonlySet<string>;
  onChange: (ids: Set<string>) => void;
  onRetry: () => void;
}

export function RecipientsStep({ contactsState, selectedIds, onChange, onRetry }: RecipientsStepProps) {
  const [query, setQuery] = useState('');
  const { contacts } = contactsState;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    const digits = q.replace(/[^0-9]/g, '');
    return contacts.filter((c) => c.displayName.toLowerCase().includes(q) || (digits !== '' && c.e164.includes(digits)));
  }, [contacts, query]);

  const selected = contacts.filter((c) => selectedIds.has(c.id));
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selectedIds.has(c.id));

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function toggleVisible() {
    const next = new Set(selectedIds);
    for (const c of visible) {
      if (allVisibleSelected) next.delete(c.id);
      else next.add(c.id);
    }
    onChange(next);
  }

  return (
    <div className="stack">
      <div>
        <h1 className="section-title">Choose recipients</h1>
        <p className="section-subtitle">Select the firm's clients who should receive this message.</p>
      </div>

      <div className="search">
        <SearchIcon size={18} />
        <input className="input" type="search" placeholder="Search by name or number" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {selected.length > 0 && (
        <div className="chips" aria-label="Selected contacts">
          {selected.map((c) => (
            <span key={c.id} className="chip">
              {c.displayName}
              <button aria-label={`Remove ${c.displayName}`} onClick={() => toggle(c.id)}>
                <CloseIcon size={14} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="row row--between">
        <span className="muted">
          {selected.length} selected{contactsState.status === 'ready' ? ` of ${contacts.length}` : ''}
        </span>
        <div className="row">
          {selected.length > 0 && (
            <button className="btn btn--ghost btn--sm" onClick={() => onChange(new Set())}>
              Clear
            </button>
          )}
          {visible.length > 0 && (
            <button className="btn btn--ghost btn--sm" onClick={toggleVisible}>
              {allVisibleSelected ? 'Deselect shown' : query ? 'Select shown' : 'Select all'}
            </button>
          )}
        </div>
      </div>

      {contactsState.status === 'loading' && (
        <div className="card row" style={{ justifyContent: 'center', color: 'var(--text-muted)' }}>
          <span className="spinner" /> Loading clients…
        </div>
      )}

      {contactsState.status === 'error' && (
        <div className="alert alert--error stack">
          <span>Couldn't load clients: {contactsState.error}</span>
          <button className="btn btn--secondary btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {contactsState.status === 'ready' && visible.length === 0 && (
        <div className="card muted" style={{ textAlign: 'center' }}>
          {query ? 'No clients match your search.' : 'No clients with a mobile number yet. Add phone numbers in the Clients tab.'}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="contact-list">
          {visible.map((c) => {
            const isSelected = selectedIds.has(c.id);
            return (
              <li key={c.id} className={isSelected ? 'contact-row contact-row--selected' : 'contact-row'} onClick={() => toggle(c.id)}>
                <Avatar initials={initialsFor(c.displayName)} size={36} variant="contact" />
                <div className="contact-row__text">
                  <div className="contact-row__name">{c.displayName}</div>
                  <div className="contact-row__phone">{c.e164}</div>
                </div>
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={isSelected}
                  aria-label={`Select ${c.displayName}`}
                  onChange={() => toggle(c.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              </li>
            );
          })}
        </ul>
      )}

      {(contactsState.suppressedCount > 0 || contactsState.noPhoneCount > 0 || contactsState.inactiveCount > 0) && (
        <p className="faint">
          {/* Named separately, never merged into one count (§18.3.1) — a user who sees a single number assumes the wrong reason. */}
          Not shown:{' '}
          {[
            contactsState.suppressedCount > 0 ? `${contactsState.suppressedCount} opted out of messages` : '',
            contactsState.inactiveCount > 0 ? `${contactsState.inactiveCount} inactive` : '',
            contactsState.noPhoneCount > 0 ? `${contactsState.noPhoneCount} without a mobile number` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      )}
    </div>
  );
}
