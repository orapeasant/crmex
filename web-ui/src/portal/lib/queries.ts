// TanStack Query hooks over shared-ui's org-scoped repositories.
// Every key starts with ['org', orgId] and the whole QueryClient is recreated
// per user+firm (see FirmScope), so cached rows can never bleed across firms.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getClientById,
  getMatterById,
  listClients,
  listMatterClients,
  listMatters,
  listMessageHistory,
  listOrgMemberRows,
  listTasks,
  loadBatch,
  loadBatchHistory,
  loadClientMatters,
  loadUsageStats,
  useActiveFirm,
  useApp,
} from 'shared-ui';
import { useCallback } from 'react';

export function useOrgKey() {
  const { orgId } = useActiveFirm();
  return useCallback((...parts: unknown[]) => ['org', orgId, ...parts] as const, [orgId]);
}

export function useInvalidateFirm() {
  const qc = useQueryClient();
  const { orgId } = useActiveFirm();
  return useCallback(() => qc.invalidateQueries({ queryKey: ['org', orgId] }), [qc, orgId]);
}

export function useClients() {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'clients'], queryFn: () => listClients(supabase, orgId) });
}

export function useClient(id: string) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'client', id], queryFn: () => getClientById(supabase, orgId, id) });
}

export function useClientMatters(clientId: string) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'client', clientId, 'matters'], queryFn: () => loadClientMatters(supabase, orgId, clientId) });
}

export function useClientMessages(clientId: string) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'client', clientId, 'messages'], queryFn: () => listMessageHistory(supabase, orgId, { clientId, limit: 100 }) });
}

export function useMatters() {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'matters'], queryFn: () => listMatters(supabase, orgId) });
}

export function useMatter(id: string) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'matter', id], queryFn: () => getMatterById(supabase, orgId, id) });
}

export function useMatterLinks(matterId: string) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'matter', matterId, 'links'], queryFn: () => listMatterClients(supabase, orgId, { matterId }) });
}

export function useTasks() {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'tasks'], queryFn: () => listTasks(supabase, orgId) });
}

/** org_members rows readable by fellow members (assignees, sender names). */
export function useMemberRows() {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'member-rows'], queryFn: () => listOrgMemberRows(supabase, orgId).catch(() => []) });
}

export function useHistory() {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'history'], queryFn: () => loadBatchHistory(supabase, orgId) });
}

export function useBatch(batchId: string, live: boolean) {
  const { supabase } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'batch', batchId], queryFn: () => loadBatch(supabase, orgId, batchId), refetchInterval: live ? 4000 : false });
}

export function useUsage() {
  const { supabase, user } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'usage', user.id], queryFn: () => loadUsageStats(supabase, orgId, user.id) });
}

export function useMembers() {
  const { api } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'members'], queryFn: () => api.listMembers(orgId) });
}

export function useInvitations(enabled: boolean) {
  const { api } = useApp();
  const { orgId } = useActiveFirm();
  return useQuery({ queryKey: ['org', orgId, 'invitations'], queryFn: () => api.listInvitations(orgId), enabled });
}
