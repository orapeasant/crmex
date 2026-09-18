import { useMemo, useState } from 'react';
import { clientKindLabel, collectTags, filterClients } from '../../crm/clients.js';
import { CLIENT_KINDS, type ClientKind } from '../../crm/types.js';
import { listClients } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { Avatar, initialsFor } from '../ui/Avatar.js';
import { EmptyState, ErrorCard, Fab, FilterChips, LoadingCard } from '../ui/components.js';
import { BanIcon, ChevronRightIcon, DownloadIcon, SearchIcon, UsersIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';

export function ClientsList() {
  const { supabase, platform } = useApp();
  const { orgId, dataVersion } = useActiveFirm();
  const nav = useNav();
  const clients = useAsync(() => listClients(supabase, orgId), [supabase, orgId, dataVersion]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ClientKind | null>(null);
  const [tag, setTag] = useState<string | null>(null);

  const all = clients.data ?? [];
  const tags = useMemo(() => collectTags(all), [all]);
  const visible = useMemo(() => filterClients(all, { query, kind, tag }), [all, query, kind, tag]);
  const filtered = Boolean(query.trim() || kind || tag);

  return (
    <main className="content content--with-fab stack">
      <div className="row row--between">
        <div>
          <h1 className="section-title">Clients</h1>
          {clients.data && (
            <p className="faint">
              {filtered ? `${visible.length} of ${all.length}` : `${all.length} ${all.length === 1 ? 'client' : 'clients'}`}
            </p>
          )}
        </div>
        {platform.contacts && (
          <button className="btn btn--secondary btn--sm" onClick={() => nav.push({ name: 'client-import' })}>
            <DownloadIcon size={16} /> Import
          </button>
        )}
      </div>

      <div className="search">
        <SearchIcon size={18} />
        <input className="input" type="search" placeholder="Search name, phone, email or tag" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <FilterChips label="Filter by kind" value={kind} options={CLIENT_KINDS} onChange={setKind} />
      {tags.length > 0 && <FilterChips label="Filter by tag" value={tag} options={tags.slice(0, 20).map((t) => ({ value: t, label: `#${t}` }))} onChange={setTag} />}

      {clients.status === 'loading' && <LoadingCard label="Loading clients…" />}
      {clients.status === 'error' && <ErrorCard error={clients.error} onRetry={clients.reload} prefix="Couldn't load clients" />}

      {clients.data && all.length === 0 && (
        <EmptyState
          icon={<UsersIcon size={28} />}
          title="No clients yet"
          text="Add the people and organisations your firm works with."
          action={
            <div className="row row--wrap" style={{ justifyContent: 'center' }}>
              <button className="btn btn--primary" onClick={() => nav.push({ name: 'client-form' })}>
                Add client
              </button>
              {platform.contacts && (
                <button className="btn btn--secondary" onClick={() => nav.push({ name: 'client-import' })}>
                  Import from phone
                </button>
              )}
            </div>
          }
        />
      )}

      {clients.data && all.length > 0 && visible.length === 0 && <div className="card muted" style={{ textAlign: 'center' }}>No clients match these filters.</div>}

      {visible.length > 0 && (
        <ul className="contact-list">
          {visible.map((c) => (
            <li key={c.id} className="contact-row" onClick={() => nav.push({ name: 'client', id: c.id })}>
              <Avatar initials={initialsFor(c.display_name)} size={40} variant="contact" />
              <div className="contact-row__text">
                <div className="contact-row__name">{c.display_name}</div>
                <div className="contact-row__phone">
                  {clientKindLabel(c.kind)}
                  {c.phone_e164 ? ` · ${c.phone_e164}` : c.email ? ` · ${c.email}` : ''}
                </div>
              </div>
              {c.suppressed_at && (
                <span className="badge badge--warning" title="Opted out of messages">
                  <BanIcon size={12} /> Opted out
                </span>
              )}
              <ChevronRightIcon size={18} />
            </li>
          ))}
        </ul>
      )}

      <Fab label="New client" onClick={() => nav.push({ name: 'client-form' })} />
    </main>
  );
}
