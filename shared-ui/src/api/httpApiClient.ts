// ApiClient implementation against the exact /api/v1 contract given for this
// build. Deliberately does not deviate from the contract even where it is
// slightly narrower than crmex.md §11's sketch (e.g. §11's ApiClient.generateImage
// returns a Blob — this contract returns JSON with a signedUrl the caller
// fetches separately, matching how core-server actually responds).
import type {
  ApiClient,
  ContactIndexEntry,
  CreatedInvitation,
  ImageSearchResult,
  ImageSessionResult,
  OrgInvitation,
  OrgMember,
  OrgRole,
  OrgSummary,
} from '../types.js';
import { ApiError } from '../types.js';

export interface HttpApiClientOptions {
  baseUrl: string; // e.g. 'https://core.example.com/api/v1' — no trailing slash
  getAccessToken: () => Promise<string | null>;
  /** Active firm for firm-scoped routes, sent as X-Org-Id (crmex.md §15.4). The server verifies membership. */
  getOrgId?: () => string | null;
  fetchImpl?: typeof fetch;
}

interface ErrorBody {
  error: { code: string; message: string };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly getOrgId: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.getOrgId = opts.getOrgId ?? (() => null);
    // Browsers throw "Illegal invocation" when fetch is called with `this`
    // bound to anything but the global object, which a stored method reference would do.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async health(): Promise<{ ok: true }> {
    // /health is exempt from auth per the contract.
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    return this.parse<{ ok: true }>(res);
  }

  // --- Firm-scoped (X-Org-Id) ---

  async matchContacts(query: string, index: ContactIndexEntry[]): Promise<string[]> {
    const body = await this.request<{ matchedIds: string[] }>('POST', '/contacts/match', { query, index }, true);
    return body.matchedIds;
  }

  async draftMessage(prompt: string): Promise<string> {
    const body = await this.request<{ text: string }>('POST', '/messages/draft', { prompt }, true);
    return body.text;
  }

  async generateImage(prompt: string): Promise<ImageSessionResult> {
    return this.request<ImageSessionResult>('POST', '/images/generate', { prompt }, true);
  }

  async refineImage(sessionId: string, instruction: string): Promise<ImageSessionResult> {
    return this.request<ImageSessionResult>('POST', `/images/${encodeURIComponent(sessionId)}/refine`, { instruction }, true);
  }

  async searchImages(query: string, limit?: number): Promise<ImageSearchResult[]> {
    const body = await this.request<{ results: ImageSearchResult[] }>('POST', '/images/search', { query, limit }, true);
    return body.results;
  }

  async selectSearchImage(sourceUrl: string, query: string): Promise<ImageSessionResult> {
    return this.request<ImageSessionResult>('POST', '/images/search/select', { sourceUrl, query }, true);
  }

  // --- Firms, members, invitations (firm given in the path) ---

  async listOrgs(): Promise<OrgSummary[]> {
    return (await this.request<{ orgs: OrgSummary[] }>('GET', '/orgs')).orgs;
  }

  async createOrg(name: string): Promise<OrgSummary> {
    return (await this.request<{ org: OrgSummary }>('POST', '/orgs', { name })).org;
  }

  async listMembers(orgId: string): Promise<OrgMember[]> {
    return (await this.request<{ members: OrgMember[] }>('GET', `/orgs/${encodeURIComponent(orgId)}/members`)).members;
  }

  async changeMemberRole(orgId: string, userId: string, role: OrgRole): Promise<OrgMember> {
    const path = `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`;
    return (await this.request<{ member: OrgMember }>('PATCH', path, { role })).member;
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.request<void>('DELETE', `/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`);
  }

  async listInvitations(orgId: string): Promise<OrgInvitation[]> {
    return (await this.request<{ invitations: OrgInvitation[] }>('GET', `/orgs/${encodeURIComponent(orgId)}/invitations`)).invitations;
  }

  async createInvitation(orgId: string, input: { email?: string; role: Exclude<OrgRole, 'owner'> }): Promise<CreatedInvitation> {
    return this.request<CreatedInvitation>('POST', `/orgs/${encodeURIComponent(orgId)}/invitations`, input);
  }

  async revokeInvitation(orgId: string, invitationId: string): Promise<void> {
    await this.request<void>('DELETE', `/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`);
  }

  async acceptInvitation(token: string): Promise<OrgSummary> {
    return (await this.request<{ org: OrgSummary }>('POST', '/invitations/accept', { token })).org;
  }

  private async request<T>(method: Method, path: string, payload?: unknown, firmScoped = false): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new ApiError('UNAUTHORIZED', 'No Supabase access token available', 401);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (firmScoped) {
      const orgId = this.getOrgId();
      if (!orgId) throw new ApiError('ORG_REQUIRED', 'No firm selected', 400);
      headers['X-Org-Id'] = orgId;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const errBody = json as Partial<ErrorBody> | null;
      const code = errBody?.error?.code ?? `HTTP_${res.status}`;
      const message = errBody?.error?.message ?? res.statusText;
      throw new ApiError(code, message, res.status);
    }
    return json as T;
  }
}
