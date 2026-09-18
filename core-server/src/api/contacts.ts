import { Router } from 'express';
import { z } from 'zod';
import { matchContacts } from '../agent/contactMatcher';
import type { LlmProvider } from '../providers/types';
import { withTimeout, TimeoutError } from '../lib/withTimeout';
import { ProviderError, ProviderTimeoutError } from '../lib/errors';

const ContactIndexEntrySchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
    lastContactAt: z.string().optional(),
  })
  // .passthrough(), not .strict(): extra client-supplied fields (accidental
  // or hostile) are tolerated here and then dropped by
  // buildAllowlistedIndex — the allow-list is the real control, not
  // request-shape rejection.
  .passthrough();

const MatchRequestSchema = z.object({
  query: z.string().min(1),
  index: z.array(ContactIndexEntrySchema),
});

export interface ContactsRouterDeps {
  llmProvider: LlmProvider;
  providerTimeoutMs: number;
}

/** POST /api/v1/contacts/match — see agent/contactMatcher.ts for the privacy/behavioural guarantees. */
export function createContactsRouter(deps: ContactsRouterDeps): Router {
  const router = Router();

  router.post('/match', async (req, res, next) => {
    try {
      const parsed = MatchRequestSchema.parse(req.body);
      const result = await withTimeout(
        matchContacts(deps.llmProvider, parsed.query, parsed.index),
        deps.providerTimeoutMs,
        'Contact matching timed out',
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof TimeoutError) return next(new ProviderTimeoutError(err.message));
      if ((err as { name?: string })?.name === 'ZodError') return next(err);
      if (err instanceof Error) return next(new ProviderError(err.message, 'LLM_ERROR'));
      next(err);
    }
  });

  return router;
}
