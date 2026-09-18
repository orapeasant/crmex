import express, { type Express } from 'express';
import type { SupabaseLike } from './db/types';
import type { ImageGenProvider, ImageSearchProvider, LlmProvider } from './providers/types';
import { createAuthMiddleware } from './auth/middleware';
import { createHealthRouter } from './api/health';
import { createContactsRouter } from './api/contacts';
import { createImagesRouter } from './api/images';
import { createMessagesRouter } from './api/messages';
import { createAdminRouter } from './api/admin';
import { errorHandler } from './api/errorHandler';
import { createImageSessionsRepo } from './repositories/imageSessionsRepo';
import { createOrgUsageRepo } from './repositories/orgUsageRepo';
import { createOrgsRepo } from './repositories/orgsRepo';
import { createInvitationsRepo } from './repositories/invitationsRepo';
import { createAuditRepo } from './repositories/auditRepo';
import { createOrgService } from './agent/orgService';
import { createOrgsRouter, createInvitationsRouter } from './api/orgs';
import { requireOrgMember } from './auth/orgMiddleware';
import { createSettingsRepo } from './repositories/settingsRepo';
import { createStorageRepo } from './repositories/storageRepo';
import { createSessionLock } from './lib/sessionLock';
import { createCorsMiddleware, DEFAULT_CORS_ORIGINS } from './lib/cors';

export interface CreateAppOptions {
  supabase: SupabaseLike;
  llmProvider: LlmProvider;
  /** LLM used for message drafting; defaults to llmProvider. Production wires a faster, cheaper model. */
  draftLlmProvider?: LlmProvider;
  imageGenProvider: ImageGenProvider;
  imageSearchProvider: ImageSearchProvider;
  /** Injectable for tests; defaults to a real fetch()-based downloader restricted to http(s). */
  fetchImageBytes?: (url: string) => Promise<Buffer>;
  signedUrlTtlSeconds?: number;
  providerTimeoutMs?: number;
  /**
   * Timeout for image generation/refinement. Image models routinely take far
   * longer than an LLM call, so this defaults to providerTimeoutMs when that
   * is set explicitly (tests) and to 120s otherwise.
   */
  imageProviderTimeoutMs?: number;
  /** Injectable clock for deterministic tests (quota day-rollover, timestamps). */
  now?: () => number;
  /** Browser origins allowed to call the API; defaults to the Capacitor WebView origins. */
  corsAllowedOrigins?: readonly string[];
}

async function defaultFetchImageBytes(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Builds the Express app from injected dependencies (crmex.md §6 — routes
 * import only the provider interfaces). Real wiring (real Supabase client,
 * real provider instances from the factory) happens in src/index.ts; tests
 * call this directly with a fake Supabase client and fake providers so the
 * whole HTTP layer runs with zero network access.
 */
export function createApp(opts: CreateAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(createCorsMiddleware(opts.corsAllowedOrigins ?? DEFAULT_CORS_ORIGINS));
  app.use(express.json({ limit: '15mb' }));

  const now = opts.now ?? Date.now;
  const signedUrlTtlSeconds = opts.signedUrlTtlSeconds ?? 300;
  const providerTimeoutMs = opts.providerTimeoutMs ?? 20_000;
  const imageProviderTimeoutMs = opts.imageProviderTimeoutMs ?? opts.providerTimeoutMs ?? 120_000;
  const fetchImageBytes = opts.fetchImageBytes ?? defaultFetchImageBytes;

  const storageRepo = createStorageRepo(opts.supabase, signedUrlTtlSeconds);
  const imageSessionsRepo = createImageSessionsRepo(opts.supabase);
  const orgUsageRepo = createOrgUsageRepo(opts.supabase, now);
  const orgsRepo = createOrgsRepo(opts.supabase);
  const auditRepo = createAuditRepo(opts.supabase);
  const orgService = createOrgService({ orgsRepo, invitationsRepo: createInvitationsRepo(opts.supabase), auditRepo, now });
  const settingsRepo = createSettingsRepo(opts.supabase);

  const imageAgentDeps = {
    imageGenProvider: opts.imageGenProvider,
    imageSearchProvider: opts.imageSearchProvider,
    storageRepo,
    imageSessionsRepo,
    orgUsageRepo,
    settingsRepo,
    fetchImageBytes,
    providerTimeoutMs: imageProviderTimeoutMs,
    now,
    lock: createSessionLock(),
  };

  // /health is the one route exempt from auth (per the API contract).
  app.use('/api/v1/health', createHealthRouter());

  const auth = createAuthMiddleware(opts.supabase);
  const protectedRouter = express.Router();
  protectedRouter.use(auth);
  // Firm management: the :orgId path param is verified per route inside the router.
  protectedRouter.use('/orgs', createOrgsRouter({ orgService, orgsRepo }));
  protectedRouter.use('/invitations', createInvitationsRouter({ orgService }));
  protectedRouter.use('/admin', createAdminRouter({ orgsRepo, auditRepo }));

  // Firm-scoped data routes: X-Org-Id is checked against org_members on every request (§15.4).
  const firmMember = requireOrgMember(orgsRepo, 'header');
  protectedRouter.use('/contacts', firmMember, createContactsRouter({ llmProvider: opts.llmProvider, providerTimeoutMs }));
  protectedRouter.use(
    '/messages',
    firmMember,
    createMessagesRouter({ llmProvider: opts.draftLlmProvider ?? opts.llmProvider, providerTimeoutMs, settingsRepo, orgUsageRepo }),
  );
  protectedRouter.use('/images', firmMember, createImagesRouter(imageAgentDeps));
  app.use('/api/v1', protectedRouter);

  app.use(errorHandler);

  return app;
}
