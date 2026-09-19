// Row shapes of the firm-scoped CRM tables (supabase/migrations/20260913000100_crm_core.sql,
// crmex.md §15.3 / §15.10). Every row belongs to exactly one firm (org_id).

export type ClientKind = 'client' | 'prospect' | 'opposing_counsel' | 'court' | 'other';
export const CLIENT_KINDS: { value: ClientKind; label: string }[] = [
  { value: 'client', label: 'Client' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'opposing_counsel', label: 'Opposing counsel' },
  { value: 'court', label: 'Court' },
  { value: 'other', label: 'Other' },
];

/**
 * CRM lifecycle of the relationship (crmex.md §18.3.1), set by the firm.
 * Deliberately separate from `suppressed_at`, which is the person's own
 * opt-out (§12): a client can be active and opted out, or inactive and never
 * opted out, and reactivating one must never resume messaging someone who
 * asked you to stop. Campaigns target `active` only; both flags exclude, and
 * the excluded line names them separately because a user who sees one count
 * will assume the wrong reason.
 */
export type ClientStatus = 'active' | 'inactive' | 'archived';
export const CLIENT_STATUSES: { value: ClientStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'archived', label: 'Archived' },
];

export interface ClientRow {
  id: string;
  org_id: string;
  created_by: string | null;
  display_name: string;
  phone_e164: string | null;
  email: string | null;
  kind: ClientKind;
  tags: string[];
  notes: string | null;
  opted_in_at: string | null;
  suppressed_at: string | null;
  source: 'manual' | 'phone_import';
  status: ClientStatus;
  created_at: string;
  updated_at: string;
}

/** Fields a user may set on a client. org_id, id and created_by are never taken from here. */
export interface ClientInput {
  display_name: string;
  phone_e164?: string | null;
  email?: string | null;
  kind?: ClientKind;
  tags?: string[];
  notes?: string | null;
  opted_in_at?: string | null;
  suppressed_at?: string | null;
}

export type MatterStatus = 'open' | 'pending' | 'closed';
export const MATTER_STATUSES: { value: MatterStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'closed', label: 'Closed' },
];

export interface MatterRow {
  id: string;
  org_id: string;
  created_by: string | null;
  matter_number: string;
  title: string;
  practice_area: string | null;
  status: MatterStatus;
  opened_on: string; // yyyy-mm-dd
  closed_on: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatterInput {
  matter_number: string;
  title: string;
  practice_area?: string | null;
  status?: MatterStatus;
  opened_on?: string;
  closed_on?: string | null;
  notes?: string | null;
}

export type MatterClientRole = 'client' | 'opposing_party' | 'witness' | 'other';
export const MATTER_CLIENT_ROLES: { value: MatterClientRole; label: string }[] = [
  { value: 'client', label: 'Client' },
  { value: 'opposing_party', label: 'Opposing party' },
  { value: 'witness', label: 'Witness' },
  { value: 'other', label: 'Other' },
];

export interface MatterClientRow {
  matter_id: string;
  client_id: string;
  org_id: string;
  role: MatterClientRole;
  created_at: string;
}

export type TaskKind = 'task' | 'deadline' | 'hearing';
export const TASK_KINDS: { value: TaskKind; label: string }[] = [
  { value: 'task', label: 'Task' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'hearing', label: 'Hearing' },
];

export interface TaskRow {
  id: string;
  org_id: string;
  created_by: string | null;
  title: string;
  notes: string | null;
  kind: TaskKind;
  status: 'open' | 'done';
  due_at: string | null;
  matter_id: string | null;
  assignee_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  title: string;
  notes?: string | null;
  kind?: TaskKind;
  due_at?: string | null;
  matter_id?: string | null;
  assignee_id?: string | null;
}

/** org_members as readable by fellow members (for assignee pickers and sender names). */
export interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  email: string | null;
  display_name: string | null;
}

export type SendJobStatus = 'queued' | 'claimed' | 'done' | 'cancelled' | 'failed' | 'expired';

export interface SendJobRecipient {
  client_id: string;
  jid: string;
  display_name: string;
}

export interface SendJobRow {
  id: string;
  org_id: string;
  created_by: string | null;
  status: SendJobStatus;
  body: string | null;
  media_path: string | null;
  recipients: SendJobRecipient[];
  claimed_at: string | null;
  finished_at: string | null;
  error: string | null;
  /**
   * Campaign columns (crmex.md §18.3.2). All null on a job queued the
   * pre-§18 way, which still means "run as soon as the phone sees it".
   * Immutable after insert, like body and recipients — rescheduling is
   * cancel-and-recreate, so one row is always one run.
   */
  scheduled_at: string | null;
  interval_ms: number | null;
  jitter_pct: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A job is runnable when it is queued, due, and not past its window (§18.3.2). */
export function isJobDue(job: SendJobRow, now: Date = new Date()): boolean {
  if (job.status !== 'queued') return false;
  const t = now.getTime();
  if (job.scheduled_at && Date.parse(job.scheduled_at) > t) return false;
  if (job.expires_at && Date.parse(job.expires_at) <= t) return false;
  return true;
}

/** Past its window and still unclaimed: the phone reports it rather than sending late (§18.3.2). */
export function isJobExpired(job: SendJobRow, now: Date = new Date()): boolean {
  return job.status === 'queued' && job.expires_at !== null && Date.parse(job.expires_at) <= now.getTime();
}
