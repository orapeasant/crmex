import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Live fixtures for the I-level cases of docs/spec/test-plan.md §18 (TEN-*)
 * and §2 (ISO-*).
 *
 * The suites under test/integration prove core-server's own scoping against
 * test/fakes/fakeSupabaseClient.ts. They cannot prove that the *database*
 * enforces the same thing: RLS policies, grants, composite foreign keys and
 * the guard triggers only exist in Postgres. These run through supabase-js
 * against a real Supabase project, exactly as a client would.
 *
 * Opt-in: set LIVE_SUPABASE=1 (credentials are read from core-server/.env).
 * Everything is created under a per-run prefix and torn down afterwards, so
 * the suite never touches data that was already in the project.
 */

export interface LiveUser {
  id: string;
  email: string;
  /** supabase-js client carrying this user's JWT — subject to RLS. */
  db: SupabaseClient;
  accessToken: string;
}

export interface LiveFixture {
  /** service-role client: bypasses RLS, used only for setup and assertions. */
  admin: SupabaseClient;
  anon: SupabaseClient;
  orgA: string;
  orgB: string;
  /** Firm A owner. */
  A1: LiveUser;
  /** Firm A member. */
  A2: LiveUser;
  /** Firm B owner. */
  B1: LiveUser;
  /** Member of BOTH firms — several holes are only reachable as X. */
  X: LiveUser;
  runId: string;
  teardown: () => Promise<void>;
}

function readEnvFile(file: string): Record<string, string> {
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    vars[t.slice(0, t.indexOf('=')).trim()] = t.slice(t.indexOf('=') + 1).trim();
  }
  return vars;
}

/**
 * The anon key is required, not optional: several cases assert that the
 * `anon` role sees nothing, and running those with the service role (which
 * has BYPASSRLS) would pass while proving the opposite. It is not a secret —
 * it ships in every browser bundle — so it is read from web-ui/.env when
 * core-server/.env does not carry one.
 */
export function liveEnv(): { url: string; serviceKey: string; anonKey: string } | null {
  if (!process.env.LIVE_SUPABASE) return null;
  const server = readEnvFile(path.resolve(__dirname, '../../.env'));
  const web = readEnvFile(path.resolve(__dirname, '../../../web-ui/.env'));

  const url = server.SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = server.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = server.SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? web.VITE_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) return null;
  if (web.VITE_SUPABASE_URL && web.VITE_SUPABASE_URL !== url) {
    throw new Error('web-ui/.env points at a different Supabase project than core-server/.env');
  }
  return { url, serviceKey, anonKey };
}

const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false } } as const;

export async function setupLiveFixture(): Promise<LiveFixture> {
  const env = liveEnv();
  if (!env) throw new Error('live env not configured');

  const admin = createClient(env.url, env.serviceKey, CLIENT_OPTS);
  const anon = createClient(env.url, env.anonKey, CLIENT_OPTS);
  const runId = randomUUID().slice(0, 8);
  const password = `Test-${randomUUID()}`;
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];

  const makeUser = async (label: string): Promise<LiveUser> => {
    const email = `crmex-live-${runId}-${label.toLowerCase()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `Live ${label}` },
    });
    if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
    createdUsers.push(data.user.id);

    const authed = createClient(env.url, env.anonKey, CLIENT_OPTS);
    const { data: session, error: signInError } = await authed.auth.signInWithPassword({ email, password });
    if (signInError || !session.session) throw new Error(`signIn ${label}: ${signInError?.message}`);

    // A client that sends this user's JWT on every PostgREST/Storage request,
    // i.e. runs as `authenticated` with auth.uid() = this user.
    const db = createClient(env.url, env.anonKey, {
      ...CLIENT_OPTS,
      global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
    });
    return { id: data.user.id, email, db, accessToken: session.session.access_token };
  };

  const makeOrg = async (name: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('organizations')
      .insert({ name: `${name} ${runId}`, created_by: createdBy })
      .select('id')
      .single();
    if (error || !data) throw new Error(`createOrg ${name}: ${error?.message}`);
    createdOrgs.push(data.id);
    return data.id;
  };

  const addMember = async (orgId: string, u: LiveUser, role: 'owner' | 'admin' | 'member') => {
    const { error } = await admin
      .from('org_members')
      .insert({ org_id: orgId, user_id: u.id, role, email: u.email });
    if (error) throw new Error(`addMember: ${error.message}`);
  };

  const [A1, A2, B1, X] = await Promise.all([makeUser('A1'), makeUser('A2'), makeUser('B1'), makeUser('X')]);

  const orgA = await makeOrg('Live Firm A', A1.id);
  const orgB = await makeOrg('Live Firm B', B1.id);

  await addMember(orgA, A1, 'owner');
  await addMember(orgA, A2, 'member');
  await addMember(orgB, B1, 'owner');
  await addMember(orgA, X, 'member');
  await addMember(orgB, X, 'member');

  const teardown = async () => {
    // Orgs cascade to every firm-scoped row; users are removed afterwards so
    // nothing is left behind in auth.users either.
    for (const id of createdOrgs) await admin.from('organizations').delete().eq('id', id);
    for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  };

  return { admin, anon, orgA, orgB, A1, A2, B1, X, runId, teardown };
}

/** A phone number that is unique per run, so re-runs never collide. */
export function livePhone(runId: string, n: number): string {
  const digits = parseInt(runId.slice(0, 6), 16).toString().padStart(8, '0').slice(0, 8);
  return `+1${digits}${String(n).padStart(2, '0')}`;
}
