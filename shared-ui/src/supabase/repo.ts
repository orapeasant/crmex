// Direct-from-app Supabase access (RLS-protected, user's own session) for
// the tables the architecture note says bypass core-server entirely:
// message_history writes/reads, contact_meta reads/writes, image_sessions
// list/detail, and fresh signed URLs for already-known paths.
//
// core-server is used only for generation/refinement/search and contact NL
// matching (needs provider keys or server-controlled storage paths) — see
// the project brief's "Architecture note resolving an ambiguity".
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MirrorResult } from '../send/outboxManager.js';

export interface MessageHistoryRow {
  id: number;
  org_id: string;
  /** Sender; null once the sender's account has been deleted. */
  user_id: string | null;
  jid: string;
  display_name: string | null;
  body: string | null;
  media_path: string | null;
  media_sha256: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  error_reason: string | null;
  batch_id: string;
  client_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ContactMetaRow {
  id: number;
  org_id: string;
  /** Sender; null once the sender's account has been deleted. */
  user_id: string | null;
  jid: string;
  tags: string[] | null;
  notes: string | null;
}

export interface ImageSessionRow {
  id: number;
  org_id: string;
  user_id: string;
  prompt_history: unknown;
  current_path: string | null;
  source: 'generated' | 'searched';
  created_at: string;
  updated_at: string;
}

/** Mirrors one settled outbox result into `message_history` (crmex.md §9.2). */
export async function mirrorMessageResult(client: SupabaseClient, result: MirrorResult): Promise<void> {
  const { error } = await client.from('message_history').insert({
    org_id: result.orgId,
    jid: result.jid,
    client_id: result.clientId ?? null,
    display_name: result.displayName ?? null,
    body: result.body ?? null,
    media_path: result.mediaPath ?? null,
    status: result.status,
    error_reason: result.errorReason ?? null,
    batch_id: result.batchId,
    resolved_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// RLS returns every firm the caller belongs to, so each firm-data read also filters by the active firm.
export async function listContactMeta(client: SupabaseClient, orgId: string): Promise<ContactMetaRow[]> {
  const { data, error } = await client.from('contact_meta').select('*').eq('org_id', orgId);
  if (error) throw error;
  return (data ?? []) as ContactMetaRow[];
}

export async function upsertContactMeta(
  client: SupabaseClient,
  orgId: string,
  jid: string,
  fields: { tags?: string[]; notes?: string },
): Promise<void> {
  const { error } = await client.from('contact_meta').upsert(
    { org_id: orgId, jid, ...fields },
    { onConflict: 'org_id,jid' },
  );
  if (error) throw error;
}

export async function listImageSessions(client: SupabaseClient, orgId: string): Promise<ImageSessionRow[]> {
  const { data, error } = await client
    .from('image_sessions')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ImageSessionRow[];
}

export async function getImageSession(client: SupabaseClient, id: number): Promise<ImageSessionRow | null> {
  const { data, error } = await client.from('image_sessions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as ImageSessionRow | null) ?? null;
}

/**
 * Fresh signed URL for an already-known object path, requested with the
 * user's own session (RLS/folder-prefix policy enforces the caller can only
 * ever get a URL for their own prefix — crmex.md §3.3/§4, tested by ISO-08).
 */
export async function refreshSignedUrl(client: SupabaseClient, path: string, ttlSeconds = 300): Promise<string> {
  const { data, error } = await client.storage.from('user-images').createSignedUrl(path, ttlSeconds);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error('No signed URL returned');
  return data.signedUrl;
}

/** Suppression list (crmex.md §12, SAF-03) — survives across sessions/devices
 * because it lives in Supabase, keyed by jid like contact_meta. Modeled as a
 * tag on contact_meta ('suppressed') rather than a new table, since it is
 * exactly per-user per-jid metadata the schema already supports. */
export async function isSuppressed(client: SupabaseClient, orgId: string, jid: string): Promise<boolean> {
  const { data, error } = await client
    .from('contact_meta')
    .select('tags')
    .eq('org_id', orgId)
    .eq('jid', jid)
    .maybeSingle();
  if (error) throw error;
  return Boolean((data as { tags?: string[] } | null)?.tags?.includes('suppressed'));
}

export async function addSuppression(client: SupabaseClient, orgId: string, jid: string): Promise<void> {
  const existing = await client.from('contact_meta').select('tags').eq('org_id', orgId).eq('jid', jid).maybeSingle();
  if (existing.error) throw existing.error;
  const tags = new Set<string>((existing.data as { tags?: string[] } | null)?.tags ?? []);
  tags.add('suppressed');
  await upsertContactMeta(client, orgId, jid, { tags: Array.from(tags) });
}
