import { Router } from 'express';
import { z } from 'zod';
import { draftMessage } from '../agent/messageDrafter';
import type { LlmProvider } from '../providers/types';
import type { OrgUsageRepo } from '../repositories/orgUsageRepo';
import { reserveMessageDraft, type SettingsRepoLike } from '../quota/quota';
import { withTimeout, TimeoutError } from '../lib/withTimeout';
import { AppError, NotAMemberError, ProviderError, ProviderTimeoutError } from '../lib/errors';

const DraftRequestSchema = z.object({ prompt: z.string().trim().min(1).max(2000) });

export interface MessagesRouterDeps {
  llmProvider: LlmProvider;
  providerTimeoutMs: number;
  settingsRepo: SettingsRepoLike;
  orgUsageRepo: OrgUsageRepo;
}

/**
 * POST /api/v1/messages/draft — LLM-written message text from a short
 * description. Mounted behind requireOrgMember; req.orgId (verified) is used
 * solely for the per-firm draft quota — nothing identifying reaches the LLM.
 */
export function createMessagesRouter(deps: MessagesRouterDeps): Router {
  const router = Router();

  router.post('/draft', async (req, res, next) => {
    try {
      const { prompt } = DraftRequestSchema.parse(req.body);
      if (!req.orgId) throw new NotAMemberError();
      // Quota reserved before the provider call, so a rejected request costs nothing (§13.5).
      // Attempts are counted: a call that reaches the provider may bill even if it fails.
      await reserveMessageDraft({ orgUsageRepo: deps.orgUsageRepo, settingsRepo: deps.settingsRepo, orgId: req.orgId });
      const result = await withTimeout(draftMessage(deps.llmProvider, prompt), deps.providerTimeoutMs, 'Message drafting timed out');
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof AppError) return next(err);
      if (err instanceof TimeoutError) return next(new ProviderTimeoutError(err.message));
      if ((err as { name?: string })?.name === 'ZodError') return next(err);
      if (err instanceof Error) {
        // Vendor error bodies (billing state, request ids) stay in the server
        // log; the client gets a stable, renderable message.
        // eslint-disable-next-line no-console
        console.error('Message drafting failed:', err.message);
        return next(new ProviderError('Message drafting failed', 'LLM_ERROR'));
      }
      next(err);
    }
  });

  return router;
}
