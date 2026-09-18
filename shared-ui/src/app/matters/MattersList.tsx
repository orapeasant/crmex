import { useMemo, useState } from 'react';
import { MATTER_STATUSES, type MatterRow, type MatterStatus } from '../../crm/types.js';
import { listMatters } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { EmptyState, ErrorCard, Fab, LoadingCard, Segmented } from '../ui/components.js';
import { BriefcaseIcon, ChevronRightIcon, SearchIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { formatDate } from '../ui/util.js';

export const MATTER_BADGE: Record<MatterStatus, string> = {
  open: 'badge badge--success',
  pending: 'badge badge--warning',
  closed: 'badge badge--neutral',
};

type Filter = MatterStatus | 'all';

export function MattersList() {
  const { supabase } = useApp();
  const { orgId, dataVersion } = useActiveFirm();
  const nav = useNav();
  const matters = useAsync(() => listMatters(supabase, orgId), [supabase, orgId, dataVersion]);
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');

  const all = matters.data ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: all.length, open: 0, pending: 0, closed: 0 };
    all.forEach((m) => c[m.status]++);
    return c;
  }, [all]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (m: MatterRow) =>
        (filter === 'all' || m.status === filter) &&
        (!q || m.title.toLowerCase().includes(q) || m.matter_number.toLowerCase().includes(q) || (m.practice_area ?? '').toLowerCase().includes(q)),
    );
  }, [all, filter, query]);

  return (
    <main className="content content--with-fab stack">
      <h1 className="section-title">Matters</h1>
      <Segmented
        label="Status"
        value={filter}
        onChange={setFilter}
        options={[...MATTER_STATUSES.map((s) => ({ value: s.value as Filter, label: `${s.label}${matters.data ? ` ${counts[s.value]}` : ''}` })), { value: 'all', label: 'All' }]}
      />
      <div className="search">
        <SearchIcon size={18} />
        <input className="input" type="search" placeholder="Search title, number or practice area" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {matters.status === 'loading' && <LoadingCard label="Loading matters…" />}
      {matters.status === 'error' && <ErrorCard error={matters.error} onRetry={matters.reload} prefix="Couldn't load matters" />}
      {matters.data && all.length === 0 && (
        <EmptyState
          icon={<BriefcaseIcon size={28} />}
          title="No matters yet"
          text="Open a matter to track its clients, deadlines and hearings."
          action={
            <button className="btn btn--primary" onClick={() => nav.push({ name: 'matter-form' })}>
              New matter
            </button>
          }
        />
      )}
      {matters.data && all.length > 0 && visible.length === 0 && <div className="card muted" style={{ textAlign: 'center' }}>No matters match.</div>}

      {visible.length > 0 && (
        <ul className="contact-list">
          {visible.map((m) => (
            <li key={m.id} className="contact-row" onClick={() => nav.push({ name: 'matter', id: m.id })}>
              <span className="icon-tile icon-tile--sm">
                <BriefcaseIcon size={18} />
              </span>
              <div className="contact-row__text">
                <div className="contact-row__name">{m.title}</div>
                <div className="contact-row__phone">
                  {m.matter_number}
                  {m.practice_area ? ` · ${m.practice_area}` : ''} · opened {formatDate(m.opened_on)}
                </div>
              </div>
              <span className={MATTER_BADGE[m.status]}>{MATTER_STATUSES.find((s) => s.value === m.status)?.label}</span>
              <ChevronRightIcon size={18} />
            </li>
          ))}
        </ul>
      )}

      <Fab label="New matter" onClick={() => nav.push({ name: 'matter-form' })} />
    </main>
  );
}
