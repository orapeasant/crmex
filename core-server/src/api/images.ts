import { Router, type Request } from 'express';
import { z } from 'zod';
import { generateImage, refineImage, searchImages, selectSearchedImage } from '../agent/imageAgent';
import type { FirmScope, ImageAgentDeps } from '../agent/imageAgent';
import { NotAMemberError } from '../lib/errors';

/** Firm + caller from the verified membership (orgMiddleware) and JWT — never from the body. */
function scopeOf(req: Request): FirmScope {
  // Unreachable when mounted behind requireOrgMember; fail closed if it ever isn't.
  if (!req.orgId || !req.userId) throw new NotAMemberError();
  return { orgId: req.orgId, userId: req.userId };
}

const GenerateSchema = z.object({ prompt: z.string().min(1) });
const RefineSchema = z.object({ instruction: z.string().min(1) });
const SearchSchema = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(50).optional() });
const SelectSchema = z.object({ sourceUrl: z.string().url(), query: z.string().min(1) });

/**
 * POST /api/v1/images/generate|:sessionId/refine|search|search/select.
 * Mounted behind requireOrgMember (X-Org-Id verified against org_members).
 * Every handler derives orgId/userId exclusively from req.orgId/req.userId
 * — never from req.body.
 */
export function createImagesRouter(deps: ImageAgentDeps): Router {
  const router = Router();

  router.post('/generate', async (req, res, next) => {
    try {
      const { prompt } = GenerateSchema.parse(req.body);
      const result = await generateImage(deps, scopeOf(req), prompt);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:sessionId/refine', async (req, res, next) => {
    try {
      const { instruction } = RefineSchema.parse(req.body);
      const result = await refineImage(deps, scopeOf(req), req.params.sessionId, instruction);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/search', async (req, res, next) => {
    try {
      const { query, limit } = SearchSchema.parse(req.body);
      const results = await searchImages(deps, query, limit);
      res.status(200).json({ results });
    } catch (err) {
      next(err);
    }
  });

  router.post('/search/select', async (req, res, next) => {
    try {
      const { sourceUrl, query } = SelectSchema.parse(req.body);
      const result = await selectSearchedImage(deps, scopeOf(req), sourceUrl, query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
