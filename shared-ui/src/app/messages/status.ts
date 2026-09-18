export const STATUS_BADGE: Record<'QUEUED' | 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED', { label: string; className: string }> = {
  QUEUED: { label: 'Waiting', className: 'badge badge--neutral' },
  PENDING: { label: 'Pending', className: 'badge badge--neutral' },
  SENT: { label: 'Sent', className: 'badge badge--success' },
  FAILED: { label: 'Failed', className: 'badge badge--danger' },
  SKIPPED: { label: 'Skipped', className: 'badge badge--warning' },
};

export const SKIP_REASON_LABELS: Record<string, string> = {
  NOT_CONFIRMED: 'Not selected',
  SUPPRESSED: 'Opted out',
  NOT_ON_WHATSAPP: 'Not on WhatsApp',
  DUPLICATE: 'Duplicate number',
};

export const JOB_STATUS: Record<string, { label: string; className: string }> = {
  queued: { label: 'Waiting for your phone', className: 'badge badge--neutral' },
  claimed: { label: 'Sending from your phone', className: 'badge badge--neutral' },
  done: { label: 'Finished', className: 'badge badge--success' },
  cancelled: { label: 'Cancelled', className: 'badge badge--warning' },
  failed: { label: 'Failed', className: 'badge badge--danger' },
};
