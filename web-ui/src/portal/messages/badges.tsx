import { JOB_STATUS, SKIP_REASON_LABELS, STATUS_BADGE, type SendJobStatus } from 'shared-ui';
import { StatusBadge, type Tone } from '../components/common';

const RECIPIENT_TONE: Record<string, Tone> = { QUEUED: 'neutral', PENDING: 'neutral', SENT: 'success', FAILED: 'danger', SKIPPED: 'warning' };
// `expired` (crmex.md §18.3.2) is a warning, not a danger: the campaign was never
// claimed inside its late window, so nothing failed and nothing was sent — it simply
// stopped being worth sending. Same tone as `cancelled` for that reason.
const JOB_TONE: Record<SendJobStatus, Tone> = { queued: 'info', claimed: 'info', done: 'success', cancelled: 'warning', failed: 'danger', expired: 'warning' };

export function RecipientStatusBadge({ status, label }: { status: keyof typeof STATUS_BADGE; label?: string }) {
  return <StatusBadge tone={RECIPIENT_TONE[status] ?? 'neutral'}>{label ?? STATUS_BADGE[status]?.label ?? status}</StatusBadge>;
}

export function JobStatusBadge({ status }: { status: SendJobStatus }) {
  return <StatusBadge tone={JOB_TONE[status]}>{JOB_STATUS[status]?.label ?? status}</StatusBadge>;
}

export function reasonLabel(reason: string | null): string | null {
  return reason ? (SKIP_REASON_LABELS[reason] ?? reason) : null;
}
