// A small local HTTP server implementing the exact /api/v1 contract, used to
// integration-test HttpApiClient since the real core-server isn't running
// (it's being built in parallel against the same contract). Node's built-in
// http module only — no extra deps.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface MockServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
  requests: { method: string; path: string; auth: string | undefined; orgId: string | undefined; body: unknown }[];
}

export interface MockServerOptions {
  /** Token that must be presented as `Bearer <token>` for non-/health routes. Default: any non-empty token is accepted. */
  expectedToken?: string;
  /** Force the next /images/generate or /refine call to return 429 QUOTA_EXCEEDED. */
  forceQuotaExceeded?: boolean;
  /** Force /images/:sessionId/refine to 404 (simulates "not the caller's session"). */
  forceRefine404?: boolean;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startMockCoreServer(opts: MockServerOptions = {}): Promise<MockServerHandle> {
  const requests: MockServerHandle['requests'] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const auth = req.headers.authorization;

    if (path === '/api/v1/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7).length === 0) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header' } });
      return;
    }
    if (opts.expectedToken && auth.slice(7) !== opts.expectedToken) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
      return;
    }

    const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
    const orgHeader = req.headers['x-org-id'];
    const orgId = typeof orgHeader === 'string' ? orgHeader : undefined;
    requests.push({ method: req.method ?? 'GET', path, auth, orgId, body });

    const firmScoped = path === '/api/v1/contacts/match' || path === '/api/v1/messages/draft' || path.startsWith('/api/v1/images/');
    if (firmScoped && !orgId) {
      sendJson(res, 400, { error: { code: 'ORG_REQUIRED', message: 'X-Org-Id header required' } });
      return;
    }

    const mockOrg = { id: 'org-new', name: 'Mock Firm', plan: 'free', role: 'owner', createdAt: new Date(0).toISOString() };
    if (path === '/api/v1/orgs' && req.method === 'GET') {
      sendJson(res, 200, { orgs: [mockOrg] });
      return;
    }
    if (path === '/api/v1/orgs' && req.method === 'POST') {
      sendJson(res, 201, { org: { ...mockOrg, name: (body as { name: string }).name } });
      return;
    }
    if (path === '/api/v1/invitations/accept') {
      const { token } = body as { token: string };
      if (token !== 'good-token') {
        sendJson(res, 404, { error: { code: 'INVITATION_INVALID', message: 'Invitation is invalid or has expired' } });
        return;
      }
      sendJson(res, 200, { org: { ...mockOrg, role: 'member' } });
      return;
    }
    if (req.method === 'DELETE' && /^\/api\/v1\/orgs\/[^/]+\/members\/[^/]+$/.test(path)) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/api/v1/contacts/match') {
      const { index } = body as { query: string; index: { id: string }[] };
      // Deterministic fake matcher: match every id whose displayName contains
      // a query substring is out of scope for a mock — just return every id
      // so tests can assert plumbing, or none for an empty query.
      const b = body as { query: string };
      const matchedIds = b.query.trim().length === 0 ? [] : index.map((e) => e.id);
      sendJson(res, 200, { matchedIds });
      return;
    }

    if (path === '/api/v1/images/generate') {
      if (opts.forceQuotaExceeded) {
        sendJson(res, 429, { error: { code: 'QUOTA_EXCEEDED', message: 'Daily image quota exceeded' } });
        return;
      }
      sendJson(res, 200, {
        sessionId: 'sess_mock_1',
        path: 'mock-user/deadbeef.png',
        signedUrl: 'https://example.invalid/signed/deadbeef.png?ttl=300',
        promptHistory: [{ role: 'user', prompt: (body as { prompt: string }).prompt, timestamp: new Date().toISOString() }],
      });
      return;
    }

    if (path.match(/^\/api\/v1\/images\/[^/]+\/refine$/)) {
      if (opts.forceRefine404) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found or not owned by caller' } });
        return;
      }
      if (opts.forceQuotaExceeded) {
        sendJson(res, 429, { error: { code: 'QUOTA_EXCEEDED', message: 'Daily image quota exceeded' } });
        return;
      }
      sendJson(res, 200, {
        path: 'mock-user/refined.png',
        signedUrl: 'https://example.invalid/signed/refined.png?ttl=300',
        promptHistory: [
          { role: 'user', prompt: 'original', timestamp: new Date(0).toISOString() },
          { role: 'user', prompt: (body as { instruction: string }).instruction, timestamp: new Date().toISOString() },
        ],
      });
      return;
    }

    if (path === '/api/v1/images/search') {
      sendJson(res, 200, {
        results: [
          { id: 'img1', thumbUrl: 'https://example.invalid/thumb1.png', sourceUrl: 'https://example.invalid/full1.png', source: 'mock' },
        ],
      });
      return;
    }

    if (path === '/api/v1/images/search/select') {
      sendJson(res, 200, {
        sessionId: 'sess_mock_2',
        path: 'mock-user/searched.png',
        signedUrl: 'https://example.invalid/signed/searched.png?ttl=300',
        promptHistory: [],
      });
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No mock route for ${path}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    server,
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
