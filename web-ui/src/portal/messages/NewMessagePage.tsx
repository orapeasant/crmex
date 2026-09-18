// Compose -> Recipients -> Review, full page. Rules deciding what may be sent
// live in shared-ui (clientRecipients, buildReviewQueue/buildQueue,
// queueSendJob). In the browser Send never talks to WhatsApp: it queues a
// send_job that the user's own phone runs (crmex.md §15.10). Two distinct
// actions are required to send (Send, then confirm — SAF-04).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ImagePlus, Search, Send, Smartphone, Sparkles, Trash2, X } from 'lucide-react';
import {
  EMPTY_DRAFT,
  MAX_BATCH_RECIPIENTS,
  MAX_MESSAGE_CHARS,
  SKIP_REASON_LABELS,
  buildReviewQueue,
  clientKindLabel,
  clientRecipients,
  describeError,
  draftImage,
  isDraftComplete,
  queueSendJob,
  useActiveFirm,
  useApp,
  useMessaging,
  type BuiltQueue,
  type ClientRow,
  type MessageDraft,
  type RecipientContact,
} from 'shared-ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog, ErrorState, Initials, Section, Spinner, StatusBadge, TableSkeleton } from '../components/common';
import { DataTable } from '../components/DataTable';
import { FormError } from '../components/form';
import { useClients, useInvalidateFirm } from '../lib/queries';
import { BatchDetail } from './BatchDetailPage';

const STEPS = ['Compose', 'Recipients', 'Review & confirm'];

type Review = { status: 'checking' } | { status: 'ready'; queue: BuiltQueue } | { status: 'error'; error: string };

export function NewMessagePage() {
  const { supabase, api, user } = useApp();
  const { orgId } = useActiveFirm();
  const messaging = useMessaging();
  const invalidate = useInvalidateFirm();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const clients = useClients();

  const step = Math.min(2, Math.max(0, Number(params.get('step') ?? 0) || 0));
  // The unsent draft survives a refresh in this tab (sessionStorage, per user and firm). Only the text and
  // selected client ids are kept: a generated image's preview URL is a short-lived signed URL (a bearer
  // credential) and is never persisted, so an attached image has to be generated again after a reload.
  const draftKey = `crmex:draft:${user.id}:${orgId}`;
  const saved = useState(() => loadDraft(draftKey))[0];
  const [draft, setDraft] = useState<MessageDraft>(() => (saved ? { ...EMPTY_DRAFT, text: saved.text } : EMPTY_DRAFT));
  const [selection, setSelection] = useState<RowSelectionState>(() => {
    const to = (params.get('to') ?? '').split(',').filter(Boolean);
    const ids = to.length > 0 ? to : (saved?.clientIds ?? []);
    return Object.fromEntries(ids.map((id) => [id, true]));
  });
  const [review, setReview] = useState<Review>({ status: 'checking' });
  const [confirming, setConfirming] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queuedJobId, setQueuedJobId] = useState<string | null>(null);

  useEffect(() => {
    const clientIds = Object.keys(selection).filter((id) => selection[id]);
    try {
      if (!draft.text && clientIds.length === 0) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ text: draft.text, clientIds }));
    } catch {
      /* storage unavailable */
    }
  }, [draft.text, selection, draftKey]);

  const recipients = useMemo(() => (clients.data ? clientRecipients(clients.data) : null), [clients.data]);
  const selected = useMemo(() => (recipients?.recipients ?? []).filter((c) => selection[c.id]), [recipients, selection]);

  // Steps are in the URL so browser Back moves between them; you can't skip ahead of a complete draft.
  function goTo(next: number) {
    const p = new URLSearchParams(params);
    p.delete('to');
    if (next === 0) p.delete('step');
    else p.set('step', String(next));
    setParams(p);
    window.scrollTo({ top: 0 });
  }
  useEffect(() => {
    if (queuedJobId) return;
    if (step >= 1 && !isDraftComplete(draft)) goTo(0);
    else if (step === 2 && selected.length === 0 && recipients) goTo(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, recipients]);

  async function runReview() {
    setReview({ status: 'checking' });
    try {
      const queue = await buildReviewQueue({ supabase, orgId, selected, body: draft.text, mediaPath: draftImage(draft)?.path ?? null, checkRegistered: messaging.checkRegistered });
      setReview({ status: 'ready', queue });
    } catch (err) {
      setReview({ status: 'error', error: describeError(err) });
    }
  }
  useEffect(() => {
    if (step === 2 && selected.length > 0) void runReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function queue() {
    if (review.status !== 'ready') return;
    setQueueing(true);
    setQueueError(null);
    try {
      const items = review.queue.items;
      const { job } = await queueSendJob(supabase, {
        orgId,
        userId: user.id,
        body: items[0]?.body ?? null,
        mediaPath: items[0]?.mediaPath ?? null,
        clientIds: items.map((i) => i.clientId).filter((id): id is string => Boolean(id)),
      });
      setConfirming(false);
      setQueuedJobId(job.id);
      clearDraft(draftKey);
      await invalidate();
    } catch (err) {
      setConfirming(false);
      setQueueError(describeError(err));
    } finally {
      setQueueing(false);
    }
  }

  if (queuedJobId) {
    return (
      <>
        <div className="border-b bg-card px-6 py-5 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300">
                <Check className="size-5" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Message queued</h1>
                <p className="text-sm text-muted-foreground">Your phone will send it. You can leave this page; progress also appears under Messages.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" asChild>
                <Link to={`/messages/batches/${queuedJobId}`}>Open details</Link>
              </Button>
              <Button
                onClick={() => {
                  setQueuedJobId(null);
                  setDraft(EMPTY_DRAFT);
                  setSelection({});
                  setParams(new URLSearchParams(), { replace: true });
                }}
              >
                New message
              </Button>
            </div>
          </div>
        </div>
        <div className="px-6 py-6 lg:px-8">
          <BatchDetail batchId={queuedJobId} embedded />
        </div>
      </>
    );
  }

  const sendable = review.status === 'ready' ? review.queue.items.length : 0;
  const tooMany = sendable > MAX_BATCH_RECIPIENTS;

  return (
    <div className="flex min-h-[calc(100svh-3.5rem)] flex-col">
      <div className="border-b bg-card px-6 py-5 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">New message</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sent on WhatsApp from your own account, by your phone.</p>
          </div>
          <Stepper current={step} />
        </div>
      </div>

      <div className="flex-1 px-6 py-6 lg:px-8">
        {messaging.mode === 'queue' && step === 0 && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm text-sky-900 dark:text-sky-300">
            <Smartphone className="mt-0.5 size-4 shrink-0" />
            <span>The web app can't send WhatsApp messages itself. When you confirm, the message is queued and your phone sends it — Leagentex must be open on your phone with WhatsApp linked.</span>
          </div>
        )}
        {step === 0 && <ComposeStep draft={draft} onChange={setDraft} api={api} />}
        {step === 1 && <RecipientsStep clients={clients.data} isLoading={clients.isLoading} error={clients.error} onRetry={() => void clients.refetch()} recipients={recipients} selection={selection} onSelectionChange={setSelection} />}
        {step === 2 && <ReviewStep draft={draft} selectedCount={selected.length} review={review} onRetry={() => void runReview()} onEditRecipients={() => goTo(1)} />}
        {queueError && (
          <div className="mt-4">
            <FormError error={`Couldn't queue the message: ${queueError}`} />
          </div>
        )}
      </div>

      <div className="sticky bottom-0 z-10 border-t bg-card px-6 py-3 shadow-[0_-1px_3px_rgba(0,0,0,0.04)] lg:px-8">
        <div className="flex items-center gap-2">
          {step === 0 ? (
            <Button variant="ghost" onClick={() => navigate('/messages')}>
              Cancel
            </Button>
          ) : (
            <Button variant="outline" onClick={() => goTo(step - 1)}>
              <ArrowLeft /> Back
            </Button>
          )}
          <div className="ml-auto flex items-center gap-3">
            {step === 1 && <span className="text-sm text-muted-foreground">{selected.length} selected</span>}
            {step === 0 && (
              <Button disabled={!isDraftComplete(draft)} onClick={() => goTo(1)}>
                Next: Recipients <ArrowRight />
              </Button>
            )}
            {step === 1 && (
              <Button disabled={selected.length === 0} onClick={() => goTo(2)}>
                Review ({selected.length}) <ArrowRight />
              </Button>
            )}
            {step === 2 && (
              <Button disabled={review.status !== 'ready' || sendable === 0 || tooMany} onClick={() => setConfirming(true)}>
                <Send /> Send
              </Button>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Send to ${sendable} ${sendable === 1 ? 'person' : 'people'}?`}
        description="Your phone will send it from your WhatsApp account. It must be online with Leagentex open. You can cancel until your phone picks it up."
        confirmLabel="Queue for my phone"
        busy={queueing}
        onConfirm={() => void queue()}
      />
    </div>
  );
}

function loadDraft(key: string): { text: string; clientIds: string[] } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { text?: unknown; clientIds?: unknown } | null;
    if (!v) return null;
    return { text: typeof v.text === 'string' ? v.text.slice(0, MAX_MESSAGE_CHARS) : '', clientIds: Array.isArray(v.clientIds) ? v.clientIds.filter((x): x is string => typeof x === 'string').slice(0, 1000) : [] };
  } catch {
    return null;
  }
}

function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Steps">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2" aria-current={i === current ? 'step' : undefined}>
          <span className={cn('flex size-6 items-center justify-center rounded-full border text-xs font-semibold', i < current && 'border-primary bg-primary text-primary-foreground', i === current && 'border-primary text-primary', i > current && 'text-muted-foreground')}>
            {i < current ? <Check className="size-3.5" /> : i + 1}
          </span>
          <span className={cn('hidden md:inline', i === current ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-8 bg-border" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function ComposeStep({ draft, onChange, api }: { draft: MessageDraft; onChange: (d: MessageDraft) => void; api: { draftMessage(p: string): Promise<string>; generateImage(p: string): Promise<{ sessionId: string; path: string; signedUrl: string }> } }) {
  const [aiPrompt, setAiPrompt] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [imagePrompt, setImagePrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  async function writeWithAi() {
    const prompt = aiPrompt.trim();
    if (!prompt || drafting) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const text = await api.draftMessage(prompt);
      onChange({ ...draft, text: text.slice(0, MAX_MESSAGE_CHARS) });
    } catch (err) {
      setDraftError(describeError(err));
    } finally {
      setDrafting(false);
    }
  }

  async function generateImage() {
    const prompt = imagePrompt.trim();
    if (!prompt || generating) return;
    setGenerating(true);
    setImageError(null);
    try {
      const r = await api.generateImage(prompt);
      // The signed URL is a short-lived bearer credential: kept in memory for the preview only.
      onChange({ ...draft, imageEnabled: true, image: { sessionId: r.sessionId, path: r.path, previewUrl: r.signedUrl } });
    } catch (err) {
      setImageError(describeError(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-3">
        <Section title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-primary" /> Draft with AI</span>}>
          <div className="flex gap-2">
            <Input aria-label="Describe the message" placeholder="e.g. Remind clients the office is closed on Friday for the public holiday" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void writeWithAi()} />
            <Button variant="secondary" onClick={() => void writeWithAi()} disabled={!aiPrompt.trim() || drafting}>
              {drafting ? <Spinner /> : <Sparkles />} Generate
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">The draft replaces the message text below. You can edit it before sending.</p>
          {draftError && <div className="mt-3"><FormError error={draftError} /></div>}
        </Section>

        <Section title="Message">
          <Textarea aria-label="Message text" className="min-h-56 leading-relaxed" placeholder="Type your message…" value={draft.text} maxLength={MAX_MESSAGE_CHARS} onChange={(e) => onChange({ ...draft, text: e.target.value })} />
          <div className="mt-2 text-right text-xs tabular-nums text-muted-foreground">
            {draft.text.length} / {MAX_MESSAGE_CHARS}
          </div>
        </Section>

        <Section
          title={<span className="inline-flex items-center gap-2"><ImagePlus className="size-4 text-primary" /> Image (optional)</span>}
          actions={<Switch aria-label="Attach an image" checked={draft.imageEnabled} onCheckedChange={(v) => onChange({ ...draft, imageEnabled: v })} />}
        >
          {!draft.imageEnabled ? (
            <p className="text-sm text-muted-foreground">Turn on to generate an image from a description and attach it.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input aria-label="Describe the image" placeholder="Describe the image" value={imagePrompt} onChange={(e) => setImagePrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void generateImage()} />
                <Button variant="secondary" onClick={() => void generateImage()} disabled={!imagePrompt.trim() || generating}>
                  {generating && <Spinner />} {draft.image ? 'Regenerate' : 'Generate'}
                </Button>
              </div>
              <div className="relative flex aspect-video max-h-80 items-center justify-center overflow-hidden rounded-md border border-dashed bg-muted/40">
                {draft.image ? (
                  <>
                    <img src={draft.image.previewUrl} alt="Generated image" className="h-full w-full object-contain" referrerPolicy="no-referrer" />
                    <Button size="icon-sm" variant="secondary" className="absolute top-2 right-2" aria-label="Remove image" onClick={() => onChange({ ...draft, image: null })}>
                      <Trash2 />
                    </Button>
                  </>
                ) : (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">{generating ? <><Spinner /> Generating image…</> : 'Your image will appear here'}</span>
                )}
              </div>
              {imageError && <FormError error={imageError} />}
            </div>
          )}
        </Section>
      </div>

      <div className="min-w-0 xl:col-span-2">
        <Section title="Preview" className="xl:sticky xl:top-20">
          <MessagePreview draft={draft} />
        </Section>
      </div>
    </div>
  );
}

function MessagePreview({ draft }: { draft: MessageDraft }) {
  const image = draftImage(draft);
  return (
    <div className="rounded-lg bg-[#e7f6ee] dark:bg-teal-950/40 p-4">
      {!draft.text.trim() && !image ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Your message preview appears here.</p>
      ) : (
        <div className="ml-auto max-w-[90%] rounded-lg rounded-tr-none bg-white dark:bg-slate-800 p-2 text-sm shadow-sm">
          {image && <img src={image.previewUrl} alt="" className="mb-2 w-full rounded" referrerPolicy="no-referrer" />}
          {draft.text.trim() && <p className="whitespace-pre-wrap break-words px-1 pb-1">{draft.text.trim()}</p>}
        </div>
      )}
    </div>
  );
}

function RecipientsStep({
  clients,
  isLoading,
  error,
  onRetry,
  recipients,
  selection,
  onSelectionChange,
}: {
  clients: ClientRow[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  recipients: ReturnType<typeof clientRecipients> | null;
  selection: RowSelectionState;
  onSelectionChange: (s: RowSelectionState) => void;
}) {
  const [query, setQuery] = useState('');
  const clientById = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c])), [clients]);
  const list = recipients?.recipients ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const digits = q.replace(/[^0-9]/g, '');
    return list.filter((c) => c.displayName.toLowerCase().includes(q) || (digits !== '' && c.e164.includes(digits)) || (clientById.get(c.id)?.tags ?? []).some((t) => t.toLowerCase().includes(q)));
  }, [list, query, clientById]);
  const selectedList = list.filter((c) => selection[c.id]);

  const columns = useMemo<ColumnDef<RecipientContact, any>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (c) => c.displayName.toLowerCase(),
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <Initials name={row.original.displayName} className="size-7" />
            <span className="font-medium">{row.original.displayName}</span>
          </div>
        ),
      },
      { id: 'phone', accessorKey: 'e164', header: 'Mobile', cell: ({ getValue }) => <span className="font-mono text-[13px]">{getValue()}</span> },
      { id: 'kind', accessorFn: (c) => (clientById.get(c.id) ? clientKindLabel(clientById.get(c.id)!.kind) : ''), header: 'Kind', meta: { className: 'hidden lg:table-cell' } },
      {
        id: 'tags',
        header: 'Tags',
        enableSorting: false,
        meta: { className: 'hidden xl:table-cell' },
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {(clientById.get(row.original.id)?.tags ?? []).slice(0, 3).map((t) => (
              <StatusBadge key={t} tone="brand">
                {t}
              </StatusBadge>
            ))}
          </div>
        ),
      },
    ],
    [clientById],
  );

  if (isLoading) return <TableSkeleton />;
  if (error) return <ErrorState error={error} onRetry={onRetry} title="Couldn't load clients" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72 xl:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" aria-label="Search recipients" placeholder="Search name, number or tag" value={query} onChange={(e) => setQuery(e.target.value)} className="bg-card pl-8" />
        </div>
        <span className="text-sm text-muted-foreground">
          {list.length} {list.length === 1 ? 'client' : 'clients'} can be messaged
          {recipients && (recipients.suppressedCount > 0 || recipients.noPhoneCount > 0) && (
            <> · not shown: {[recipients.suppressedCount > 0 ? `${recipients.suppressedCount} opted out` : '', recipients.noPhoneCount > 0 ? `${recipients.noPhoneCount} without a mobile number` : ''].filter(Boolean).join(', ')}</>
          )}
        </span>
      </div>
      {selectedList.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Selected recipients">
          {selectedList.slice(0, 12).map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded-full border bg-card py-0.5 pr-1 pl-2.5 text-xs">
              {c.displayName}
              <button type="button" className="rounded-full p-0.5 hover:bg-muted" aria-label={`Remove ${c.displayName}`} onClick={() => onSelectionChange({ ...selection, [c.id]: false })}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          {selectedList.length > 12 && <span className="text-xs text-muted-foreground">+{selectedList.length - 12} more</span>}
          <Button size="xs" variant="ghost" onClick={() => onSelectionChange({})}>
            Clear all
          </Button>
        </div>
      )}
      <DataTable
        columns={columns}
        data={visible}
        getRowId={(c) => c.id}
        rowLabel={(c) => c.displayName}
        selectable
        selection={selection}
        onSelectionChange={onSelectionChange}
        onRowClick={(c) => onSelectionChange({ ...selection, [c.id]: !selection[c.id] })}
        initialSorting={[{ id: 'name', desc: false }]}
        resetKey={query}
        pageSize={50}
        empty={query ? 'No clients match your search.' : 'No clients with a mobile number yet.'}
      />
    </div>
  );
}

function ReviewStep({ draft, selectedCount, review, onRetry, onEditRecipients }: { draft: MessageDraft; selectedCount: number; review: Review; onRetry: () => void; onEditRecipients: () => void }) {
  const items = review.status === 'ready' ? review.queue.items : [];
  const skipped = review.status === 'ready' ? review.queue.skipped : [];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-3">
        <Section
          title="Recipients"
          actions={
            <div className="flex items-center gap-2">
              {review.status === 'ready' && (
                <StatusBadge tone="brand">
                  {items.length} of {selectedCount} will receive it
                </StatusBadge>
              )}
              <Button size="sm" variant="ghost" onClick={onEditRecipients}>
                Edit
              </Button>
            </div>
          }
        >
          {review.status === 'checking' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Checking {selectedCount} recipient{selectedCount === 1 ? '' : 's'} against the firm's current opt-outs…
            </p>
          )}
          {review.status === 'error' && <ErrorState error={review.error} onRetry={onRetry} title="Couldn't check recipients" />}
          {review.status === 'ready' && (
            <ul className="max-h-[28rem] divide-y overflow-y-auto">
              {items.map((r) => (
                <li key={r.jid} className="flex items-center gap-3 py-2">
                  <Initials name={r.displayName} className="size-7" />
                  <span className="flex-1 truncate text-sm font-medium">{r.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground">+{r.jid.split('@')[0]}</span>
                  <StatusBadge tone="success">Ready</StatusBadge>
                </li>
              ))}
              {skipped.map((s) => (
                <li key={`${s.jid}:${s.reason}`} className="flex items-center gap-3 py-2 opacity-75">
                  <Initials name={s.displayName} className="size-7" />
                  <span className="flex-1 truncate text-sm">{s.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground">+{s.jid.split('@')[0]}</span>
                  <StatusBadge tone="warning">{SKIP_REASON_LABELS[s.reason] ?? s.reason}</StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </Section>
        {review.status === 'ready' && items.length > MAX_BATCH_RECIPIENTS && (
          <FormError error={`One message can go to at most ${MAX_BATCH_RECIPIENTS} recipients. Go back and select fewer.`} />
        )}
        {review.status === 'ready' && items.length === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">
            <AlertTriangle className="size-4" /> None of the selected clients can receive this message. Go back and choose different recipients.
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        <Section title="Message">
          <MessagePreview draft={draft} />
        </Section>
        <div className="flex items-start gap-3 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm text-sky-900 dark:text-sky-300">
          <Smartphone className="mt-0.5 size-4 shrink-0" />
          <span>Your phone sends this message: it needs Leagentex open with WhatsApp linked and an internet connection. It re-checks opt-outs and WhatsApp registration before sending.</span>
        </div>
      </div>
    </div>
  );
}
