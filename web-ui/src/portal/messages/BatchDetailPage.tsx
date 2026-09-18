import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Image as ImageIcon, Smartphone } from 'lucide-react';
import { batchRecipients, cancelSendJob, describeError, formatDateTime, memberLabel, subscribeSendJobs, useActiveFirm, useApp } from 'shared-ui';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, ErrorState, Fact, Initials, Section, StatusBadge, TableSkeleton } from '../components/common';
import { useCrumb } from '../layout/Topbar';
import { useBatch, useInvalidateFirm } from '../lib/queries';
import { JobStatusBadge, reasonLabel, RecipientStatusBadge } from './badges';

const FINISHED = new Set(['done', 'cancelled', 'failed']);

export function BatchDetailPage() {
  const { batchId = '' } = useParams();
  return <BatchDetail batchId={batchId} />;
}

/** Per-recipient status of one batch; follows a browser-queued job live (Realtime + polling). */
export function BatchDetail({ batchId, embedded }: { batchId: string; embedded?: boolean }) {
  const { supabase, user } = useApp();
  const { orgId } = useActiveFirm();
  const invalidate = useInvalidateFirm();
  const [live, setLive] = useState(true);
  const batch = useBatch(batchId, live);
  const job = batch.data?.job ?? null;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  useCrumb(embedded ? undefined : 'Message details');

  const isLive = job !== null && !FINISHED.has(job.status);
  useEffect(() => setLive(batch.isLoading || isLive), [batch.isLoading, isLive]);

  useEffect(() => {
    if (!isLive) return;
    return subscribeSendJobs(supabase, { column: 'id', value: batchId }, () => void batch.refetch());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, supabase, batchId]);

  const recipients = useMemo(() => (batch.data ? batchRecipients(batch.data) : []), [batch.data]);

  if (batch.isLoading) return <div className={embedded ? '' : 'p-8'}><TableSkeleton rows={4} /></div>;
  if (batch.isError) return <div className={embedded ? '' : 'p-8'}><ErrorState error={batch.error} onRetry={() => void batch.refetch()} title="Couldn't load this message" /></div>;
  const { rows, members } = batch.data!;
  if (!job && rows.length === 0) {
    return (
      <div className={embedded ? '' : 'p-8'}>
        <EmptyState title="Message not found" text="There is no record of this message in the firm's history." action={<Button variant="outline" asChild><Link to="/messages">Back to messages</Link></Button>} />
      </div>
    );
  }

  const first = rows[rows.length - 1];
  const body = job?.body ?? first?.body ?? null;
  const media = job?.media_path ?? first?.media_path ?? null;
  const senderId = job?.created_by ?? first?.user_id ?? null;
  const sender = senderId === user.id ? 'You' : memberLabel(members.find((m) => m.user_id === senderId), 'Former member');
  const when = job?.created_at ?? first?.created_at ?? null;
  const sent = rows.filter((r) => r.status === 'SENT').length;
  const failed = rows.filter((r) => r.status === 'FAILED').length;
  const skipped = rows.filter((r) => r.status === 'SKIPPED').length;
  const waiting = recipients.filter((r) => r.status === 'QUEUED' || r.status === 'PENDING').length;

  async function cancel() {
    if (!job) return;
    setCancelling(true);
    try {
      await cancelSendJob(supabase, orgId, user.id, job.id);
      toast.success('Message cancelled');
      setConfirmCancel(false);
      await invalidate();
    } catch (err) {
      toast.error(describeError(err));
      setConfirmCancel(false);
      void batch.refetch();
    } finally {
      setCancelling(false);
    }
  }

  const content = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        {job?.status === 'queued' && (
          <div className="flex items-start gap-3 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm text-sky-900 dark:text-sky-300">
            <Smartphone className="mt-0.5 size-4 shrink-0" />
            <span>
              Waiting for {senderId === user.id ? 'your' : "the sender's"} phone. It sends this message when Leagentex is open on it with WhatsApp linked and an internet connection. This page updates automatically.
            </span>
          </div>
        )}
        {job?.status === 'claimed' && (
          <div className="flex items-start gap-3 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm text-sky-900 dark:text-sky-300">
            <Smartphone className="mt-0.5 size-4 shrink-0" />
            <span>The phone is sending this message now, one recipient at a time.</span>
          </div>
        )}
        {job?.status === 'failed' && job.error && <ErrorState title="Sending failed" error={job.error} />}

        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Recipients</h2>
            <div className="flex gap-1.5">
              <StatusBadge tone="success">{sent} sent</StatusBadge>
              {failed > 0 && <StatusBadge tone="danger">{failed} failed</StatusBadge>}
              {skipped > 0 && <StatusBadge tone="warning">{skipped} skipped</StatusBadge>}
              {waiting > 0 && <StatusBadge>{waiting} waiting</StatusBadge>}
            </div>
          </div>
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs uppercase">Name</TableHead>
                <TableHead className="text-xs uppercase">Phone</TableHead>
                <TableHead className="text-xs uppercase">Status</TableHead>
                <TableHead className="hidden text-xs uppercase lg:table-cell">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Initials name={r.name} className="size-7" />
                      <span className="font-medium">{r.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{r.phone}</TableCell>
                  <TableCell>
                    <RecipientStatusBadge status={r.status} label={job?.status === 'cancelled' && r.status === 'QUEUED' ? 'Not sent' : undefined} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{reasonLabel(r.reason) ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Section title="Message">
          <div className="rounded-lg bg-[#e7f6ee] dark:bg-teal-950/40 p-3">
            <div className="ml-auto max-w-[95%] rounded-lg rounded-tr-none bg-white dark:bg-slate-800 p-3 text-sm shadow-sm">
              {media && (
                <div className="mb-2 flex items-center gap-2 rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                  <ImageIcon className="size-4" /> Image attached
                </div>
              )}
              {body ? <p className="whitespace-pre-wrap break-words">{body}</p> : !media && <p className="text-muted-foreground">No text</p>}
            </div>
          </div>
        </Section>
        <Section title="Details">
          <dl className="grid gap-4">
            <Fact label="Status">{job ? <JobStatusBadge status={job.status} /> : <StatusBadge>Sent from phone</StatusBadge>}</Fact>
            <Fact label="Sent by">{sender}</Fact>
            <Fact label="Created">{formatDateTime(when)}</Fact>
            {job?.finished_at && <Fact label="Finished">{formatDateTime(job.finished_at)}</Fact>}
            <Fact label="Recipients">{recipients.length}</Fact>
          </dl>
          {job?.status === 'queued' && job.created_by === user.id && (
            <Button variant="outline" className="mt-4 w-full text-destructive hover:text-destructive" onClick={() => setConfirmCancel(true)}>
              Cancel message
            </Button>
          )}
        </Section>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this message?"
        description="Your phone won't send it. This only works until the phone picks it up."
        confirmLabel="Cancel message"
        destructive
        busy={cancelling}
        onConfirm={() => void cancel()}
      />
    </div>
  );

  if (embedded) return content;
  return (
    <>
      <div className="border-b bg-card px-6 py-5 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Message details</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {sender} · {formatDateTime(when)} · {recipients.length} {recipients.length === 1 ? 'recipient' : 'recipients'}
        </p>
      </div>
      <div className="px-6 py-6 lg:px-8">{content}</div>
    </>
  );
}
