// DEV-ONLY preview harness. Loaded from main.tsx behind `import.meta.env.DEV`
// (open http://localhost:5173/clients?preview=1; ?preview=0 turns it off), so it
// is excluded from production builds. Renders the real portal against an
// in-memory fake Supabase (shared-ui's test fake) and a fake core-server API.
// Nothing here talks to the network; "Send" only inserts a fake send_jobs row.
import { StrictMode, useMemo, useRef } from 'react';
import type { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { CrmexProviders, profileFromUser, usePendingInvite, type AppContextValue, type OrgMember, type OrgInvitation, type OrgRole, type OrgSummary, type PlatformServices } from 'shared-ui';
import { createFakeSupabaseClient, FakeSupabaseDb } from 'shared-ui/src/testing/fakeSupabase';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createBrowserPlatform } from '../browserPlatform';
import { Portal } from '../portal/Portal';

const ME = '10000000-0000-4000-8000-000000000001';
const ORG_A = '20000000-0000-4000-8000-00000000000a';
const ORG_B = '20000000-0000-4000-8000-00000000000b';
const MEMBERS = [
  { user_id: ME, role: 'owner' as OrgRole, email: 'alex.zhang@tanpartners.sg', display_name: 'Alex Zhang' },
  { user_id: '10000000-0000-4000-8000-000000000002', role: 'admin' as OrgRole, email: 'priya.nair@tanpartners.sg', display_name: 'Priya Nair' },
  { user_id: '10000000-0000-4000-8000-000000000003', role: 'member' as OrgRole, email: 'daniel.lim@tanpartners.sg', display_name: 'Daniel Lim' },
];

const now = Date.now();
const DAY = 86_400_000;
const iso = (offsetDays: number, hour = 10) => {
  const d = new Date(now + offsetDays * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const dateOnly = (offsetDays: number) => iso(offsetDays).slice(0, 10);
const eod = (offsetDays: number) => {
  const d = new Date(now + offsetDays * DAY);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
};
let seq = 0;
const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

function seed(db: FakeSupabaseDb) {
  db.uniques.set('clients', [['org_id', 'phone_e164']]);
  db.uniques.set('matters', [['org_id', 'matter_number']]);
  const people: [string, string | null, string | null, string, string[], boolean?, boolean?][] = [
    ['Tan Wei Ming', '+6591234567', 'weiming.tan@gmail.com', 'client', ['probate', 'vip'], true],
    ['Siti Nurhaliza binte Ahmad', '+6598765432', 'siti.ahmad@outlook.com', 'client', ['family'], true],
    ['Rajesh Kumar', '+6590011223', 'rajesh.k@kumarholdings.com', 'client', ['corporate'], true],
    ['Lim Hui Shan', '+6581234987', null, 'client', ['conveyancing'], false, true],
    ['Chen Jia Hao', '+6582223344', 'jiahao.chen@nus.edu.sg', 'prospect', ['employment'], false],
    ['Nguyen Thi Lan', '+6583334455', 'lan.nguyen@yahoo.com', 'client', ['family', 'legal aid'], true],
    ['Rahman & Co (counsel)', '+6562201100', 'litigation@rahmanco.sg', 'opposing_counsel', [], false],
    ['State Courts Registry', null, 'registry@judiciary.gov.sg', 'court', [], false],
    ['Goh Boon Keng', '+6584445566', 'bk.goh@gohconstruction.sg', 'client', ['corporate', 'vip'], true],
    ['Aisha Farouk', '+6585556677', null, 'client', ['employment'], false],
    ['Marcus Teo', '+6586667788', 'marcus.teo@teofamilyoffice.com', 'client', ['probate'], true],
    ['Wong Mei Ling', '+6587778899', 'meiling.wong@gmail.com', 'prospect', [], false],
    ['Harpreet Singh', '+6588889900', 'harpreet@singhlogistics.sg', 'client', ['corporate'], true],
    ['Olivia Tan', null, 'olivia.tan@gmail.com', 'client', ['family'], false],
    ['Kelvin Ong', '+6589990011', 'kelvin.ong@ongtrading.com', 'client', ['conveyancing'], true],
    ['Fatimah Yusof', '+6591112233', 'fatimah.y@gmail.com', 'client', ['legal aid'], false],
    ['Benjamin Koh', '+6592223344', 'ben.koh@kohpartners.sg', 'other', [], false],
    ['Jessica Low', '+6593334455', 'jessica.low@lowdesign.sg', 'client', ['employment'], true],
    ['Ahmad Zulkifli', '+6594445566', null, 'client', ['probate'], false],
    ['Tay Swee Lan', '+6595556677', 'sweelan.tay@gmail.com', 'client', ['family'], true],
    ['Loh Kah Wai', '+6596667788', 'kahwai.loh@lohsteel.com', 'client', ['corporate'], false],
    ['Deepa Menon', '+6597778899', 'deepa.menon@menon.law', 'opposing_counsel', [], false],
    ['Cheryl Ng', '+6598889900', 'cheryl.ng@gmail.com', 'client', ['conveyancing'], true],
    ['Samuel Yeo', '+6599990011', 'samuel.yeo@yeoandsons.sg', 'prospect', ['corporate'], false],
    ['Irene Chua', '+6581110022', 'irene.chua@gmail.com', 'client', ['probate'], true],
    ['Vincent Ho', '+6582220033', 'vincent.ho@hofoods.com', 'client', ['employment'], false],
    ['Grace Lee', '+6583330044', 'grace.lee@leearchitects.sg', 'client', ['family'], true],
    ['Muthu Raman', '+6584440055', null, 'client', ['legal aid'], false],
  ];
  const clients = people.map(([name, phone, email, kind, tags, optedIn, suppressed], i) => ({
    id: uuid('30000000'),
    org_id: ORG_A,
    created_by: MEMBERS[i % 3].user_id,
    display_name: name,
    phone_e164: phone,
    email,
    kind,
    tags,
    notes: i === 0 ? 'Executor of his late father’s estate. Prefers WhatsApp in the evening; English and Mandarin.\n\nSister (Tan Wei Ling) is a co-beneficiary — copy her on distributions.' : null,
    opted_in_at: optedIn ? iso(-40 + i) : null,
    suppressed_at: suppressed ? iso(-5) : null,
    source: i % 5 === 3 ? 'phone_import' : 'manual',
    created_at: iso(-120 + i * 3),
    updated_at: iso(-10 + (i % 7)),
  }));
  db.table('clients').push(...clients);
  // A client of the other firm, to show firm switching never mixes data.
  db.table('clients').push({ ...clients[0], id: uuid('30000000'), org_id: ORG_B, display_name: 'Other Firm Client', phone_e164: '+6580000000', tags: [] });

  const matterDefs: [string, string, string, string, number, number | null][] = [
    ['2026-001', 'Estate of Tan Ah Kow', 'Probate', 'open', -210, null],
    ['2026-004', 'Nguyen v Tran — custody and maintenance', 'Family', 'open', -150, null],
    ['2026-007', 'Kumar Holdings — shareholder agreement', 'Corporate', 'pending', -120, null],
    ['2026-009', 'Sale of 12 Jalan Bukit Merah #08-21', 'Conveyancing', 'open', -95, null],
    ['2026-011', 'Farouk v Apex Logistics — wrongful dismissal', 'Employment', 'open', -60, null],
    ['2026-012', 'Goh Construction — payment claim (SOPA)', 'Litigation', 'open', -45, null],
    ['2026-013', 'Estate of Madam Irene Chua Swee Hoon', 'Probate', 'pending', -30, null],
    ['2025-088', 'Purchase of 3 Tanjong Rhu Road', 'Conveyancing', 'closed', -400, -300],
    ['2025-091', 'Teo Family Trust — deed of variation', 'Probate', 'closed', -380, -200],
    ['2026-014', 'Singh Logistics — employment contracts review', 'Employment', 'open', -12, null],
    ['2026-015', 'Tay v Tay — divorce ancillaries', 'Family', 'open', -6, null],
  ];
  const matters = matterDefs.map(([num, title, area, status, opened, closed]) => ({
    id: uuid('40000000'),
    org_id: ORG_A,
    created_by: ME,
    matter_number: num,
    title,
    practice_area: area,
    status,
    opened_on: dateOnly(opened),
    closed_on: closed === null ? null : dateOnly(closed),
    notes: num === '2026-001' ? 'Grant of probate applied for on 2 Sep. Awaiting extraction. Two properties and a CPF nomination; the HDB flat is to be sold after extraction.' : null,
    created_at: iso(opened),
    updated_at: iso(-2),
  }));
  db.table('matters').push(...matters);

  const link = (m: number, c: number, role: string) => db.table('matter_clients').push({ matter_id: matters[m].id, client_id: clients[c].id, org_id: ORG_A, role, created_at: iso(-20) });
  link(0, 0, 'client');
  link(0, 10, 'witness');
  link(1, 5, 'client');
  link(1, 21, 'opposing_party');
  link(2, 2, 'client');
  link(3, 14, 'client');
  link(4, 9, 'client');
  link(4, 6, 'opposing_party');
  link(5, 8, 'client');
  link(6, 24, 'client');
  link(9, 12, 'client');
  link(10, 19, 'client');
  link(0, 7, 'other');

  const tasks: [string, string, number | null, number | null, number, string, boolean?][] = [
    ['File caveat against estate', 'deadline', -2, 0, 0, ME],
    ['Call Mr Tan re: extraction of grant', 'task', 0, 0, 0, ME],
    ['Pre-trial conference', 'hearing', 0, 1, 1, MEMBERS[1].user_id],
    ['Draft affidavit of assets and means', 'deadline', 3, null, 1, ME],
    ['Review SHA redlines from counterparty', 'task', 5, null, 2, MEMBERS[2].user_id],
    ['Completion of sale', 'deadline', 9, null, 3, MEMBERS[1].user_id],
    ['Mention — Employment Claims Tribunal', 'hearing', 12, 2, 4, ME],
    ['Serve payment claim on main contractor', 'deadline', -1, null, 5, MEMBERS[2].user_id],
    ['Collect original will from client', 'task', null, null, 6, ME],
    ['Update conflict check register', 'task', null, null, -1, MEMBERS[1].user_id],
    ['Send engagement letter', 'task', -8, null, 9, ME, true],
    ['Lodge caveat at SLA', 'deadline', -15, null, 3, MEMBERS[1].user_id, true],
    ['Prepare bundle of documents', 'task', 20, null, 10, MEMBERS[2].user_id],
  ];
  db.table('tasks').push(
    ...tasks.map(([title, kind, due, hour, m, assignee, done]) => ({
      id: uuid('50000000'),
      org_id: ORG_A,
      created_by: ME,
      title,
      notes: title.startsWith('Pre-trial') ? 'Court 4B, bring client. Zoom link in the court notice.' : null,
      kind,
      status: done ? 'done' : 'open',
      due_at: due === null ? null : hour === null ? eod(due) : iso(due, 9 + hour),
      matter_id: m >= 0 ? matters[m].id : null,
      assignee_id: assignee,
      completed_at: done ? iso(due ?? -1) : null,
      created_at: iso(-30),
      updated_at: iso(-1),
    })),
  );

  db.table('org_members').push(...MEMBERS.map((m) => ({ ...m, org_id: ORG_A })));
  db.table('org_members').push({ ...MEMBERS[0], org_id: ORG_B });

  let historyId = 1;
  const batch = (daysAgo: number, sender: string, body: string, recipients: number[], statuses: string[], media: string | null = null) => {
    const batchId = uuid('60000000');
    recipients.forEach((c, i) => {
      const client = clients[c];
      const status = statuses[i] ?? 'SENT';
      db.table('message_history').push({
        id: historyId++,
        org_id: ORG_A,
        user_id: sender,
        jid: `${client.phone_e164!.slice(1)}@s.whatsapp.net`,
        display_name: client.display_name,
        body,
        media_path: media,
        media_sha256: null,
        status,
        error_reason: status === 'FAILED' ? 'NOT_ON_WHATSAPP' : status === 'SKIPPED' ? 'SUPPRESSED' : null,
        batch_id: batchId,
        client_id: client.id,
        created_at: iso(-daysAgo, 11 + i / 10),
        resolved_at: iso(-daysAgo, 11),
      });
    });
    return batchId;
  };
  batch(1, ME, 'Dear clients, please note our office will be closed on Friday for the public holiday. For urgent matters, WhatsApp this number and we will respond on Monday.', [0, 1, 2, 5, 8, 10, 12, 14, 17, 19, 22, 24, 26], ['SENT', 'SENT', 'SENT', 'SENT', 'SENT', 'SENT', 'FAILED', 'SENT', 'SENT', 'SENT', 'SENT', 'SENT', 'SENT']);
  batch(4, MEMBERS[1].user_id, 'Hi, a reminder that your pre-trial conference is tomorrow at 10am at the State Courts. Please arrive 15 minutes early.', [5], ['SENT']);
  batch(9, ME, 'Our updated fee schedule for 2027 is attached. Thank you for your continued trust in Tan & Partners.', [0, 2, 8, 12], ['SENT', 'SENT', 'SENT', 'SENT'], `${ME}/fees.png`);
  batch(21, MEMBERS[2].user_id, 'Your documents are ready for collection at our Robinson Road office.', [14, 22], ['SENT', 'SENT']);

  // A browser-queued job still waiting for the phone.
  db.table('send_jobs').push({
    id: uuid('70000000'),
    org_id: ORG_A,
    created_by: ME,
    status: 'queued',
    body: 'Good morning Mr Tan, the grant of probate has been extracted. May we schedule a call this week to discuss the sale of the flat?',
    media_path: null,
    recipients: [{ client_id: clients[0].id, jid: '6591234567@s.whatsapp.net', display_name: clients[0].display_name }],
    claimed_at: null,
    finished_at: null,
    error: null,
    created_at: iso(0, 8),
    updated_at: iso(0, 8),
  });
}

function fakeImage(prompt: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#5eead4"/></linearGradient></defs><rect width="800" height="500" fill="url(#g)"/><text x="40" y="440" font-family="system-ui" font-size="30" fill="white">${prompt.replace(/[<&>]/g, '').slice(0, 40)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function createFakeApi(role: OrgRole) {
  const orgs: OrgSummary[] = [
    { id: ORG_A, name: 'Tan & Partners LLP', plan: 'free', role, createdAt: iso(-400) },
    { id: ORG_B, name: 'Lim Chambers', plan: 'free', role: 'member', createdAt: iso(-100) },
  ];
  let invitations: OrgInvitation[] = [
    { id: 'inv-1', email: 'marcus.wee@tanpartners.sg', role: 'member', createdAt: iso(-2), expiresAt: iso(5) },
    { id: 'inv-2', email: null, role: 'admin', createdAt: iso(-1), expiresAt: iso(6) },
  ];
  const members: OrgMember[] = MEMBERS.map((m, i) => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: i === 0 ? role : m.role, joinedAt: iso(-300 + i * 40) }));
  const delay = <T,>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  return {
    listOrgs: () => delay(orgs, 150),
    createOrg: async (name: string) => delay({ id: uuid('20000000'), name, plan: 'free', role: 'owner' as OrgRole, createdAt: new Date().toISOString() }),
    listMembers: (orgId: string) => delay(orgId === ORG_A ? members : members.slice(0, 1)),
    changeMemberRole: async (_o: string, userId: string, r: OrgRole) => {
      const m = members.find((x) => x.userId === userId)!;
      m.role = r;
      return delay(m);
    },
    removeMember: async (_o: string, userId: string) => {
      members.splice(members.findIndex((m) => m.userId === userId), 1);
      return delay(undefined);
    },
    listInvitations: () => delay(invitations),
    createInvitation: async (_o: string, input: { email?: string; role: 'admin' | 'member' }) => {
      const invitation: OrgInvitation = { id: `inv-${Date.now()}`, email: input.email ?? null, role: input.role, createdAt: new Date().toISOString(), expiresAt: iso(7) };
      invitations = [invitation, ...invitations];
      const token = 'PREVIEWtokenPREVIEWtokenPREVIEWtokenPREVIEW';
      return delay({ invitation, token, inviteUrl: `crmex://invite/${token}` });
    },
    revokeInvitation: async (_o: string, id: string) => {
      invitations = invitations.filter((i) => i.id !== id);
      return delay(undefined);
    },
    acceptInvitation: async () => delay(orgs[1]),
    draftMessage: async (prompt: string) => delay(`Dear client,\n\n${prompt.trim().replace(/\.$/, '')}.\n\nIf you have any questions, simply reply to this message.\n\nWarm regards,\nTan & Partners LLP`, 700),
    generateImage: async (prompt: string) => delay({ sessionId: 'img-1', path: `${ME}/preview.png`, signedUrl: fakeImage(prompt), promptHistory: [] }, 900),
  };
}

function PreviewApp() {
  const role = useMemo<OrgRole>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('role') as OrgRole | null;
    try {
      if (fromUrl) sessionStorage.setItem('crmex:devPreviewRole', fromUrl);
      return (sessionStorage.getItem('crmex:devPreviewRole') as OrgRole | null) ?? 'owner';
    } catch {
      return fromUrl ?? 'owner';
    }
  }, []);
  const platform = useMemo<PlatformServices>(() => {
    const mem = new Map<string, string>();
    return {
      ...createBrowserPlatform('preview'),
      name: 'web-preview',
      preferences: { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), remove: async (k) => void mem.delete(k) },
      signIn: async () => {},
      purgeUserData: async () => {},
    };
  }, []);
  const invite = usePendingInvite(platform);
  const orgIdRef = useRef<string | null>(null);
  const app = useMemo<AppContextValue>(() => {
    const db = new FakeSupabaseDb();
    seed(db);
    const user = { id: ME, email: MEMBERS[0].email, app_metadata: { provider: 'google' }, user_metadata: { full_name: 'Alex Zhang', given_name: 'Alex', family_name: 'Zhang' }, aud: 'authenticated', created_at: iso(-400) } as unknown as User;
    return {
      platform,
      supabase: createFakeSupabaseClient(db) as unknown as SupabaseClient,
      api: createFakeApi(role) as unknown as AppContextValue['api'],
      user,
      profile: profileFromUser(user),
      signOut: async () => {
        window.alert('Preview: sign-out is disabled.');
      },
      openUrl: (url) => console.info('[preview] openUrl', url.split('?')[0]),
    };
  }, [platform, role]);

  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
        <div className="pointer-events-none fixed bottom-2 left-1/2 z-50 -translate-x-1/2 rounded bg-amber-400 px-2 py-0.5 text-[11px] font-semibold text-amber-950 shadow">DEV PREVIEW · fake data</div>
        <CrmexProviders app={app} orgIdRef={orgIdRef}>
          <Portal invite={invite} />
        </CrmexProviders>
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </BrowserRouter>
  );
}

export function renderPreview(root: Root) {
  root.render(
    <StrictMode>
      <PreviewApp />
    </StrictMode>,
  );
}
