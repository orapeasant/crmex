import { useState } from 'react';
import { clientKindLabel } from '../../crm/clients.js';
import { MATTER_CLIENT_ROLES } from '../../crm/types.js';
import { deleteClient, getClientById, listMatterClients, listMatters, listMessageHistory, setClientSuppressed, updateClient } from '../../supabase/crmRepo.js';
import { useActiveFirm, useApp } from '../context.js';
import { useNav } from '../shell/nav.js';
import { Avatar, initialsFor } from '../ui/Avatar.js';
import { ConfirmSheet, DetailRow, EmptyState, ErrorCard, LoadingCard, ScreenHeader, SectionLabel } from '../ui/components.js';
import { ChevronRightIcon, EditIcon, MailIcon, MessageIcon, PhoneIcon, TrashIcon } from '../ui/icons.js';
import { useAsync } from '../ui/useAsync.js';
import { describeError, formatDate, formatDateTime } from '../ui/util.js';
import { STATUS_BADGE } from '../messages/status.js';

export function ClientDetail({ id }: { id: string }) {
  const { supabase, openUrl } = useApp();
  const { orgId, canManage, dataVersion, bump } = useActiveFirm();
  const nav = useNav();

  const client = useAsync(() => getClientById(supabase, orgId, id), [supabase, orgId, id, dataVersion]);
  const matters = useAsync(async () => {
    const [links, all] = await Promise.all([listMatterClients(supabase, orgId, { clientId: id }), listMatters(supabase, orgId)]);
    const byId = new Map(all.map((m) => [m.id, m]));
    return links.flatMap((l) => {
      const m = byId.get(l.matter_id);
      return m ? [{ matter: m, role: l.role }] : [];
    });
  }, [supabase, orgId, id, dataVersion]);
  const messages = useAsync(() => listMessageHistory(supabase, orgId, { clientId: id, limit: 50 }), [supabase, orgId, id, dataVersion]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      bump();
      after?.();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const c = client.data;
  const digits = c?.phone_e164?.replace(/[^0-9]/g, '') ?? '';

  return (
    <>
      <ScreenHeader
        title={c?.display_name ?? 'Client'}
        onBack={nav.pop}
        actions={
          c && (
            <button className="icon-btn" aria-label="Edit client" onClick={() => nav.push({ name: 'client-form', id })}>
              <EditIcon />
            </button>
          )
        }
      />
      <main className="content stack">
        {client.status === 'loading' && <LoadingCard />}
        {client.status === 'error' && <ErrorCard error={client.error} onRetry={client.reload} prefix="Couldn't load this client" />}
        {client.status === 'ready' && !c && <EmptyState title="Client not found" text="It may have been deleted, or it belongs to another firm." />}

        {c && (
          <>
            <section className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
              <Avatar initials={initialsFor(c.display_name)} size={64} variant="contact" />
              <div>
                <h1 className="section-title">{c.display_name}</h1>
                <div className="row row--wrap" style={{ justifyContent: 'center', marginTop: 6 }}>
                  <span className="badge badge--neutral">{clientKindLabel(c.kind)}</span>
                  {c.tags.map((t) => (
                    <span key={t} className="badge badge--tag">
                      #{t}
                    </span>
                  ))}
                  {c.suppressed_at && <span className="badge badge--warning">Opted out</span>}
                </div>
              </div>
              <div className="quick-actions">
                <button className="quick-action" disabled={!c.phone_e164} onClick={() => openUrl(`tel:${c.phone_e164}`)}>
                  <PhoneIcon size={20} />
                  <span>Call</span>
                </button>
                <button className="quick-action" disabled={!c.email} onClick={() => openUrl(`mailto:${c.email}`)}>
                  <MailIcon size={20} />
                  <span>Email</span>
                </button>
                <button className="quick-action" disabled={!digits} onClick={() => openUrl(`https://wa.me/${digits}`)}>
                  <MessageIcon size={20} />
                  <span>WhatsApp</span>
                </button>
              </div>
            </section>

            <section className="card list-card">
              <DetailRow label="Phone">{c.phone_e164 ?? '—'}</DetailRow>
              <DetailRow label="Email">{c.email ?? '—'}</DetailRow>
              <DetailRow label="Source">{c.source === 'phone_import' ? 'Imported from phone' : 'Added manually'}</DetailRow>
              <DetailRow label="Added">{formatDate(c.created_at)}</DetailRow>
            </section>

            {c.notes && (
              <section className="card stack" style={{ gap: 6 }}>
                <div className="field__label">Notes</div>
                <div className="prewrap">{c.notes}</div>
              </section>
            )}

            <section className="stack" style={{ gap: 8 }}>
              <SectionLabel>Messaging consent</SectionLabel>
              <div className="card list-card">
                <div className="list-item">
                  <div>
                    <div>Opted in</div>
                    <div className="faint">{c.opted_in_at ? `Recorded ${formatDate(c.opted_in_at)}` : 'No opt-in recorded'}</div>
                  </div>
                  <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => updateClient(supabase, orgId, id, { opted_in_at: c.opted_in_at ? null : new Date().toISOString() }))}>
                    {c.opted_in_at ? 'Clear' : 'Record now'}
                  </button>
                </div>
                <div className="list-item">
                  <div>
                    <div>Suppress messages</div>
                    <div className="faint">{c.suppressed_at ? `Opted out ${formatDate(c.suppressed_at)} — never messaged` : 'Turn on if this client asked not to be contacted'}</div>
                  </div>
                  <button className="switch" role="switch" aria-checked={Boolean(c.suppressed_at)} aria-label="Suppress messages" disabled={busy} onClick={() => act(() => setClientSuppressed(supabase, orgId, id, !c.suppressed_at))} />
                </div>
              </div>
              {actionError && <div className="alert alert--error">{actionError}</div>}
            </section>

            <section className="stack" style={{ gap: 8 }}>
              <SectionLabel>Matters</SectionLabel>
              {matters.status === 'loading' && <LoadingCard label="Loading matters…" />}
              {matters.status === 'error' && <ErrorCard error={matters.error} onRetry={matters.reload} prefix="Couldn't load matters" />}
              {matters.data && matters.data.length === 0 && <div className="card muted">Not linked to any matter. Link clients from a matter's page.</div>}
              {matters.data && matters.data.length > 0 && (
                <div className="card list-card">
                  {matters.data.map(({ matter, role }) => (
                    <button key={matter.id} className="list-item list-item--button" onClick={() => nav.push({ name: 'matter', id: matter.id })}>
                      <div style={{ minWidth: 0 }}>
                        <div className="contact-row__name">{matter.title}</div>
                        <div className="faint">
                          {matter.matter_number} · {MATTER_CLIENT_ROLES.find((r) => r.value === role)?.label ?? role}
                        </div>
                      </div>
                      <ChevronRightIcon size={18} />
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="stack" style={{ gap: 8 }}>
              <SectionLabel>Messages sent</SectionLabel>
              {messages.status === 'loading' && <LoadingCard label="Loading messages…" />}
              {messages.status === 'error' && <ErrorCard error={messages.error} onRetry={messages.reload} prefix="Couldn't load messages" />}
              {messages.data && messages.data.length === 0 && <div className="card muted">No messages sent to this client yet.</div>}
              {messages.data && messages.data.length > 0 && (
                <div className="card list-card">
                  {messages.data.map((m) => (
                    <button key={`${m.batch_id}:${m.id}`} className="list-item list-item--button" onClick={() => nav.push({ name: 'batch', batchId: m.batch_id })}>
                      <div style={{ minWidth: 0 }}>
                        <div className="contact-row__name">{m.body?.trim() || (m.media_path ? 'Image' : 'Message')}</div>
                        <div className="faint">{formatDateTime(m.created_at)}</div>
                      </div>
                      <span className={STATUS_BADGE[m.status].className}>{STATUS_BADGE[m.status].label}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {canManage && (
              <button className="btn btn--secondary btn--danger-text" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={18} /> Delete client
              </button>
            )}
          </>
        )}
      </main>

      <ConfirmSheet
        open={confirmDelete}
        title={`Delete ${c?.display_name ?? 'client'}?`}
        message="The client is removed from the firm and unlinked from its matters. Messages already sent stay in the history."
        confirmLabel="Delete"
        danger
        busy={busy}
        error={actionError}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          act(
            () => deleteClient(supabase, orgId, id),
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
