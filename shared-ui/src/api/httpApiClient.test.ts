import { describe, it, expect, afterEach } from 'vitest';
import { HttpApiClient } from './httpApiClient.js';
import { startMockCoreServer, type MockServerHandle } from '../testing/mockCoreServer.js';
import { ApiError } from '../types.js';

let handle: MockServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('HttpApiClient against a local mock core-server (contract compliance)', () => {
  it('GET /health requires no auth', async () => {
    handle = await startMockCoreServer();
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => null });
    expect(await client.health()).toEqual({ ok: true });
  });

  it('AUTH-02 shape: a request with no token is rejected before reaching a route', async () => {
    handle = await startMockCoreServer();
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => null });
    await expect(client.matchContacts('q', [])).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('attaches Authorization: Bearer <token> on every authenticated call', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok123' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok123', getOrgId: () => 'org-a' });
    const ids = await client.matchContacts('find my vips', [{ id: 'c1', displayName: 'Alice' }]);
    expect(ids).toEqual(['c1']);
    expect(handle.requests[0].auth).toBe('Bearer tok123');
  });

  it('images/generate returns the full session shape from the contract', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok', getOrgId: () => 'org-a' });
    const result = await client.generateImage('a cat astronaut');
    expect(result.sessionId).toBeTruthy();
    expect(result.path).toBeTruthy();
    expect(result.signedUrl).toBeTruthy();
    expect(result.promptHistory[0].prompt).toBe('a cat astronaut');
  });

  it('surfaces 429 QUOTA_EXCEEDED as a typed ApiError', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok', forceQuotaExceeded: true });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok', getOrgId: () => 'org-a' });
    await expect(client.generateImage('x')).rejects.toBeInstanceOf(ApiError);
    await expect(client.generateImage('x')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
  });

  it('refine on a session not owned by the caller surfaces 404', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok', forceRefine404: true });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok', getOrgId: () => 'org-a' });
    await expect(client.refineImage('not-mine', 'make it bigger')).rejects.toMatchObject({ status: 404 });
  });

  it('search and search/select round-trip', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok', getOrgId: () => 'org-a' });
    const results = await client.searchImages('sunset');
    expect(results).toHaveLength(1);
    const selected = await client.selectSearchImage(results[0].sourceUrl, 'sunset');
    expect(selected.sessionId).toBeTruthy();
  });
});

describe('HttpApiClient firm scoping (crmex.md §15.4)', () => {
  it('sends the active firm as X-Org-Id on firm-scoped routes', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    let active = 'org-a';
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok', getOrgId: () => active });
    await client.matchContacts('q', [{ id: 'c1', displayName: 'Alice' }]);
    active = 'org-b';
    await client.generateImage('x');
    expect(handle.requests.map((r) => r.orgId)).toEqual(['org-a', 'org-b']);
  });

  it('refuses a firm-scoped call with no active firm before any request is made', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok' });
    await expect(client.draftMessage('hi')).rejects.toMatchObject({ code: 'ORG_REQUIRED' });
    expect(handle.requests).toHaveLength(0);
  });

  it('firm management routes carry the firm in the path, not the header', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok', getOrgId: () => 'org-a' });
    const orgs = await client.listOrgs();
    const created = await client.createOrg('Kuan & Partners');
    expect(orgs[0].role).toBe('owner');
    expect(created.name).toBe('Kuan & Partners');
    expect(handle.requests.every((r) => r.orgId === undefined)).toBe(true);
  });

  it('accepts an invitation token and surfaces INVITATION_INVALID', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok' });
    expect((await client.acceptInvitation('good-token')).role).toBe('member');
    await expect(client.acceptInvitation('bad')).rejects.toMatchObject({ code: 'INVITATION_INVALID', status: 404 });
  });

  it('treats 204 No Content as success', async () => {
    handle = await startMockCoreServer({ expectedToken: 'tok' });
    const client = new HttpApiClient({ baseUrl: handle.url, getAccessToken: async () => 'tok' });
    await expect(client.removeMember('org-a', 'user-2')).resolves.toBeUndefined();
    expect(handle.requests[0].method).toBe('DELETE');
  });
});
