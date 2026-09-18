// Direct-from-app access to the firm's CRM tables under RLS (crmex.md §15.3).
//
// Tenancy rules applied to EVERY function here:
//  * RLS returns rows of all firms the caller belongs to, so every read,
//    update and delete also filters `.eq('org_id', orgId)` for the active firm.
//  * Every insert sets org_id explicitly; created_by is left to the column
//    default (auth.uid()), which RLS checks.
//  * Writable fields are copied from an allow-list, so a caller-supplied
//    object can never carry org_id, id or created_by into a write.
//  * RLS turns a forbidden update/delete into "0 rows affected" rather than
//    an error, so mutations request the affected rows back and fail loudly
//    when none came back.
import type { SupabaseClient } from '@supabase/supabase-js';
import { planClientImport, type ImportPlan } from '../crm/clients.js';
import type {
  ClientInput,
  ClientRow,
  MatterClientRole,
  MatterClientRow,
  MatterInput,
  MatterRow,
  OrgMemberRow,
  TaskInput,
  TaskRow,
} from '../crm/types.js';
import type { NormalizedContact } from '../types.js';
import type { MessageHistoryRow } from './repo.js';

export class CrmPermissionError extends Error {
  code = 'NOT_PERMITTED';
  constructor(message = "You don't have permission to do that in this firm.") {
    super(message);
    this.name = 'CrmPermissionError';
  }
}

function requireOrg(orgId: string): void {
  if (!orgId) throw new Error('ORG_REQUIRED: no active firm');
}

function pick<T extends object>(src: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function emptyToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

async function one<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const list = await rows<T>(query);
  if (list.length === 0) throw new CrmPermissionError();
  return list[0];
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const CLIENT_FIELDS = ['display_name', 'phone_e164', 'email', 'kind', 'tags', 'notes', 'opted_in_at', 'suppressed_at'] as const;

function cleanClient(input: Partial<ClientInput>): Record<string, unknown> {
  const out: Record<string, unknown> = pick(input, CLIENT_FIELDS);
  if (typeof out.display_name === 'string') out.display_name = out.display_name.trim();
  if ('email' in out) out.email = emptyToNull(out.email as string | null);
  if ('notes' in out) out.notes = emptyToNull(out.notes as string | null);
  if ('phone_e164' in out) out.phone_e164 = emptyToNull(out.phone_e164 as string | null);
  return out;
}

export async function listClients(client: SupabaseClient, orgId: string): Promise<ClientRow[]> {
  requireOrg(orgId);
  return rows<ClientRow>(client.from('clients').select('*').eq('org_id', orgId).order('display_name', { ascending: true }));
}

export async function getClientById(client: SupabaseClient, orgId: string, id: string): Promise<ClientRow | null> {
  requireOrg(orgId);
  const { data, error } = await client.from('clients').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as ClientRow | null) ?? null;
}

export async function insertClient(client: SupabaseClient, orgId: string, input: ClientInput): Promise<ClientRow> {
  requireOrg(orgId);
  return one<ClientRow>(client.from('clients').insert({ ...cleanClient(input), org_id: orgId, source: 'manual' }).select('*'));
}

export async function updateClient(client: SupabaseClient, orgId: string, id: string, patch: Partial<ClientInput>): Promise<ClientRow> {
  requireOrg(orgId);
  return one<ClientRow>(client.from('clients').update(cleanClient(patch)).eq('org_id', orgId).eq('id', id).select('*'));
}

/** Records or clears an opt-out. Suppressed clients are never messaged (crmex.md §12). */
export async function setClientSuppressed(client: SupabaseClient, orgId: string, id: string, suppressed: boolean, now = new Date()): Promise<ClientRow> {
  return updateClient(client, orgId, id, { suppressed_at: suppressed ? now.toISOString() : null });
}

export async function deleteClient(client: SupabaseClient, orgId: string, id: string): Promise<void> {
  requireOrg(orgId);
  await one(client.from('clients').delete().eq('org_id', orgId).eq('id', id).select('id'));
}

export interface ImportResult extends ImportPlan {
  inserted: ClientRow[];
}

/** Adds phone contacts as clients (source 'phone_import'), skipping phones the firm already has. */
export async function importClients(client: SupabaseClient, orgId: string, selected: NormalizedContact[]): Promise<ImportResult> {
  requireOrg(orgId);
  const existing = await rows<{ phone_e164: string | null }>(client.from('clients').select('phone_e164').eq('org_id', orgId));
  const plan = planClientImport(
    existing.map((r) => r.phone_e164),
    selected,
  );
  if (plan.toInsert.length === 0) return { ...plan, inserted: [] };
  const inserted = await rows<ClientRow>(
    client
      .from('clients')
      .insert(plan.toInsert.map((r) => ({ ...r, org_id: orgId, kind: 'client', source: 'phone_import' })))
      .select('*'),
  );
  return { ...plan, inserted };
}

// ---------------------------------------------------------------------------
// Matters and matter_clients
// ---------------------------------------------------------------------------

const MATTER_FIELDS = ['matter_number', 'title', 'practice_area', 'status', 'opened_on', 'closed_on', 'notes'] as const;

function cleanMatter(input: Partial<MatterInput>): Record<string, unknown> {
  const out: Record<string, unknown> = pick(input, MATTER_FIELDS);
  if (typeof out.matter_number === 'string') out.matter_number = out.matter_number.trim();
  if (typeof out.title === 'string') out.title = out.title.trim();
  if ('practice_area' in out) out.practice_area = emptyToNull(out.practice_area as string | null);
  if ('notes' in out) out.notes = emptyToNull(out.notes as string | null);
  if ('closed_on' in out) out.closed_on = emptyToNull(out.closed_on as string | null);
  if ('opened_on' in out && !out.opened_on) delete out.opened_on;
  return out;
}

export async function listMatters(client: SupabaseClient, orgId: string): Promise<MatterRow[]> {
  requireOrg(orgId);
  return rows<MatterRow>(client.from('matters').select('*').eq('org_id', orgId).order('opened_on', { ascending: false }));
}

export async function getMatterById(client: SupabaseClient, orgId: string, id: string): Promise<MatterRow | null> {
  requireOrg(orgId);
  const { data, error } = await client.from('matters').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as MatterRow | null) ?? null;
}

export async function insertMatter(client: SupabaseClient, orgId: string, input: MatterInput): Promise<MatterRow> {
  requireOrg(orgId);
  return one<MatterRow>(client.from('matters').insert({ ...cleanMatter(input), org_id: orgId }).select('*'));
}

export async function updateMatter(client: SupabaseClient, orgId: string, id: string, patch: Partial<MatterInput>): Promise<MatterRow> {
  requireOrg(orgId);
  return one<MatterRow>(client.from('matters').update(cleanMatter(patch)).eq('org_id', orgId).eq('id', id).select('*'));
}

export async function deleteMatter(client: SupabaseClient, orgId: string, id: string): Promise<void> {
  requireOrg(orgId);
  await one(client.from('matters').delete().eq('org_id', orgId).eq('id', id).select('id'));
}

export async function listMatterClients(client: SupabaseClient, orgId: string, by: { matterId: string } | { clientId: string }): Promise<MatterClientRow[]> {
  requireOrg(orgId);
  const q = client.from('matter_clients').select('*').eq('org_id', orgId);
  return rows<MatterClientRow>('matterId' in by ? q.eq('matter_id', by.matterId) : q.eq('client_id', by.clientId));
}

export async function linkClientToMatter(client: SupabaseClient, orgId: string, matterId: string, clientId: string, role: MatterClientRole): Promise<MatterClientRow> {
  requireOrg(orgId);
  return one<MatterClientRow>(client.from('matter_clients').insert({ org_id: orgId, matter_id: matterId, client_id: clientId, role }).select('*'));
}

export async function unlinkClientFromMatter(client: SupabaseClient, orgId: string, matterId: string, clientId: string): Promise<void> {
  requireOrg(orgId);
  await one(client.from('matter_clients').delete().eq('org_id', orgId).eq('matter_id', matterId).eq('client_id', clientId).select('matter_id'));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_FIELDS = ['title', 'notes', 'kind', 'due_at', 'matter_id', 'assignee_id'] as const;

function cleanTask(input: Partial<TaskInput>): Record<string, unknown> {
  const out: Record<string, unknown> = pick(input, TASK_FIELDS);
  if (typeof out.title === 'string') out.title = out.title.trim();
  for (const k of ['notes', 'due_at', 'matter_id', 'assignee_id']) if (k in out) out[k] = emptyToNull(out[k] as string | null);
  return out;
}

export async function listTasks(client: SupabaseClient, orgId: string, opts: { matterId?: string } = {}): Promise<TaskRow[]> {
  requireOrg(orgId);
  let q = client.from('tasks').select('*').eq('org_id', orgId);
  if (opts.matterId) q = q.eq('matter_id', opts.matterId);
  return rows<TaskRow>(q.order('due_at', { ascending: true, nullsFirst: false }));
}

export async function getTaskById(client: SupabaseClient, orgId: string, id: string): Promise<TaskRow | null> {
  requireOrg(orgId);
  const { data, error } = await client.from('tasks').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as TaskRow | null) ?? null;
}

export async function insertTask(client: SupabaseClient, orgId: string, input: TaskInput): Promise<TaskRow> {
  requireOrg(orgId);
  return one<TaskRow>(client.from('tasks').insert({ ...cleanTask(input), org_id: orgId, status: 'open' }).select('*'));
}

export async function updateTask(client: SupabaseClient, orgId: string, id: string, patch: Partial<TaskInput>): Promise<TaskRow> {
  requireOrg(orgId);
  return one<TaskRow>(client.from('tasks').update(cleanTask(patch)).eq('org_id', orgId).eq('id', id).select('*'));
}

export async function setTaskDone(client: SupabaseClient, orgId: string, id: string, done: boolean, now = new Date()): Promise<TaskRow> {
  requireOrg(orgId);
  const patch = done ? { status: 'done', completed_at: now.toISOString() } : { status: 'open', completed_at: null };
  return one<TaskRow>(client.from('tasks').update(patch).eq('org_id', orgId).eq('id', id).select('*'));
}

export async function deleteTask(client: SupabaseClient, orgId: string, id: string): Promise<void> {
  requireOrg(orgId);
  await one(client.from('tasks').delete().eq('org_id', orgId).eq('id', id).select('id'));
}

// ---------------------------------------------------------------------------
// Members (read-only here; membership changes go through core-server)
// ---------------------------------------------------------------------------

export async function listOrgMemberRows(client: SupabaseClient, orgId: string): Promise<OrgMemberRow[]> {
  requireOrg(orgId);
  return rows<OrgMemberRow>(client.from('org_members').select('org_id, user_id, role, email, display_name').eq('org_id', orgId));
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

export async function listMessageHistory(
  client: SupabaseClient,
  orgId: string,
  opts: { clientId?: string; batchId?: string; limit?: number } = {},
): Promise<MessageHistoryRow[]> {
  requireOrg(orgId);
  let q = client.from('message_history').select('*').eq('org_id', orgId);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.batchId) q = q.eq('batch_id', opts.batchId);
  return rows<MessageHistoryRow>(q.order('created_at', { ascending: false }).limit(opts.limit ?? 500));
}
