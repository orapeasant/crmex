import { useMemo, useState } from 'react';
import { MATTER_CLIENT_ROLES, MATTER_STATUSES, type MatterClientRole } from '../../crm/types.js';
import { deleteMatter, getMatterById, linkClientToMatter, listClients, listMatterClients, listOrgMemberRows, listTasks, unlinkClientFromMatter } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { Avatar, initialsFor } from '../ui/Avatar.js';
import { ConfirmSheet, DetailRow, EmptyState, ErrorCard, LoadingCard, ScreenHeader, SectionLabel, Sheet } from '../ui/components.js';
import { CloseIcon, EditIcon, PlusIcon, SearchIcon, TrashIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError, formatDate } from '../ui/util.js';
import { TaskItem } from '../tasks/TaskItem.js';
import { MATTER_BADGE } from './MattersList.js';

export function MatterDetail({ id }: { id: string }) {
  const { supabase } = useApp();
  const { orgId, canManage, dataVersion, bump } = useActiveFirm();
  const nav = useNav();

  const matter = useAsync(() => getMatterById(supabase, orgId, id), [supabase, orgId, id, dataVersion]);
  const people = useAsync(async () => {
    const [links, clients] = await Promise.all([listMatterClients(supabase, orgId, { matterId: id }), listClients(supabase, orgId)]);
    return { links, clients };
  }, [supabase, orgId, id, dataVersion]);
  const tasks = useAsync(async () => {
    const [list, members] = await Promise.all([listTasks(supabase, orgId, { matterId: id }), listOrgMemberRows(supabase, orgId).catch(() => [])]);
    return { list, members };
  }, [supabase, orgId, id, dataVersion]);

  const [linking, setLinking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientById = useMemo(() => new Map((people.data?.clients ?? []).map((c) => [c.id, c])), [people.data]);
  const linked = (people.data?.links ?? []).flatMap((l) => {
    const c = clientById.get(l.client_id);
    return c ? [{ link: l, client: c }] : [];
  });

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      bump();
      after?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const m = matter.data;
  const openTasks = (tasks.data?.list ?? []).filter((t) => t.status === 'open');
  const doneTasks = (tasks.data?.list ?? []).filter((t) => t.status === 'done');

  return (
    <>
      <ScreenHeader
        title={m?.title ?? 'Matter'}
        onBack={nav.pop}
        actions={
          m && (
            <button className="icon-btn" aria-label="Edit matter" onClick={() => nav.push({ name: 'matter-form', id })}>
              <EditIcon />
            </button>
          )
        }
      />
      <main className="content stack">
        {matter.status === 'loading' && <LoadingCard />}
        {matter.status === 'error' && <ErrorCard error={matter.error} onRetry={matter.reload} prefix="Couldn't load this matter" />}
        {matter.status === 'ready' && !m && <EmptyState title="Matter not found" text="It may have been deleted." />}

        {m && (
          <>
            <section className="card stack" style={{ gap: 6 }}>
              <div className="row row--between">
                <span className="faint">{m.matter_number}</span>
                <span className={MATTER_BADGE[m.status]}>{MATTER_STATUSES.find((s) => s.value === m.status)?.label}</span>
              </div>
              <h1 className="section-title">{m.title}</h1>
              {m.practice_area && <div className="muted">{m.practice_area}</div>}
            </section>

            <section className="card list-card">
              <DetailRow label="Opened">{formatDate(m.opened_on)}</DetailRow>
              <DetailRow label="Closed">{formatDate(m.closed_on)}</DetailRow>
            </section>

            {m.notes && (
              <section className="card stack" style={{ gap: 6 }}>
                <div className="field__label">Notes</div>
                <div className="prewrap">{m.notes}</div>
              </section>
            )}

            <section className="stack" style={{ gap: 8 }}>
              <SectionLabel
                action={
                  <button className="btn btn--ghost btn--sm" onClick={() => setLinking(true)}>
                    <PlusIcon size={16} /> Link client
                  </button>
                }
              >
                People
              </SectionLabel>
              {people.status === 'loading' && <LoadingCard label="Loading people…" />}
              {people.status === 'error' && <ErrorCard error={people.error} onRetry={people.reload} prefix="Couldn't load linked clients" />}
              {people.data && linked.length === 0 && <div className="card muted">No clients linked yet.</div>}
              {linked.length > 0 && (
                <ul className="contact-list">
                  {linked.map(({ link, client }) => (
                    <li key={client.id} className="contact-row" onClick={() => nav.push({ name: 'client', id: client.id })}>
                      <Avatar initials={initialsFor(client.display_name)} size={36} variant="contact" />
                      <div className="contact-row__text">
                        <div className="contact-row__name">{client.display_name}</div>
                        <div className="contact-row__phone">{MATTER_CLIENT_ROLES.find((r) => r.value === link.role)?.label ?? link.role}</div>
                      </div>
                      <button
                        className="icon-btn"
                        aria-label={`Unlink ${client.display_name}`}
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void act(() => unlinkClientFromMatter(supabase, orgId, id, client.id));
                        }}
                      >
                        <CloseIcon size={18} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="stack" style={{ gap: 8 }}>
              <SectionLabel
                action={
                  <button className="btn btn--ghost btn--sm" onClick={() => nav.push({ name: 'task-form', matterId: id })}>
                    <PlusIcon size={16} /> Add task
                  </button>
                }
              >
                Tasks &amp; deadlines
              </SectionLabel>
              {tasks.status === 'loading' && <LoadingCard label="Loading tasks…" />}
              {tasks.status === 'error' && <ErrorCard error={tasks.error} onRetry={tasks.reload} prefix="Couldn't load tasks" />}
              {tasks.data && tasks.data.list.length === 0 && <div className="card muted">No tasks for this matter.</div>}
              {tasks.data && tasks.data.list.length > 0 && (
                <ul className="contact-list">
                  {[...openTasks, ...doneTasks].map((t) => (
                    <TaskItem key={t.id} task={t} members={tasks.data!.members} onOpen={() => nav.push({ name: 'task-form', id: t.id })} />
                  ))}
                </ul>
              )}
            </section>

            {error && <div className="alert alert--error">{error}</div>}

            {canManage && (
              <button className="btn btn--secondary btn--danger-text" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={18} /> Delete matter
              </button>
            )}
          </>
        )}
      </main>

      <LinkClientSheet
        open={linking}
        onClose={() => setLinking(false)}
        clients={(people.data?.clients ?? []).filter((c) => !linked.some((l) => l.client.id === c.id))}
        busy={busy}
        error={error}
        onLink={(clientId, role) => act(() => linkClientToMatter(supabase, orgId, id, clientId, role), () => setLinking(false))}
      />

      <ConfirmSheet
        open={confirmDelete}
        title={`Delete ${m?.title ?? 'matter'}?`}
        message="The matter and its client links are removed. Its tasks stay, without a matter."
        confirmLabel="Delete"
        danger
        busy={busy}
        error={error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          act(
            () => deleteMatter(supabase, orgId, id),
            () => {
              setConfirmDelete(false);
              nav.pop();
            },
          )
        }
      />
    </>
  );
}

function LinkClientSheet({
  open,
  onClose,
  clients,
  onLink,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  clients: { id: string; display_name: string; phone_e164: string | null }[];
  onLink: (clientId: string, role: MatterClientRole) => void;
  busy: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<MatterClientRole>('client');
  const q = query.trim().toLowerCase();
  const visible = clients.filter((c) => !q || c.display_name.toLowerCase().includes(q)).slice(0, 50);
  return (
    <Sheet open={open} onClose={onClose} title="Link a client">
      <label className="field">
        <span className="field__label">Role in this matter</span>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as MatterClientRole)}>
          {MATTER_CLIENT_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <div className="search">
        <SearchIcon size={18} />
        <input className="input" type="search" placeholder="Search clients" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      <ul className="contact-list sheet__list">
        {visible.length === 0 && <li className="contact-row muted">No clients to link. Add clients in the Clients tab.</li>}
        {visible.map((c) => (
          <li key={c.id} className="contact-row" onClick={() => !busy && onLink(c.id, role)}>
            <Avatar initials={initialsFor(c.display_name)} size={32} variant="contact" />
            <div className="contact-row__text">
              <div className="contact-row__name">{c.display_name}</div>
              {c.phone_e164 && <div className="contact-row__phone">{c.phone_e164}</div>}
            </div>
            <PlusIcon size={18} />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
