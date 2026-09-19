import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { generateImage, refineImage, searchImages, selectSearchedImage, uploadImage } from '../agent/imageAgent';
import type { FirmScope, ImageAgentDeps } from '../agent/imageAgent';
import { NotAMemberError, ValidationError } from '../lib/errors';

// Hard, framework-level ceiling on the raw body express.raw() will buffer for
// /upload, independent of the app_settings-driven quota.max_upload_bytes
// checked in uploadImage(). raw-body rejects (413) once the streamed byte
// count exceeds this, before the whole body is held in memory — the
// adjustable policy limit still applies on top, once bytes are in hand.
const UPLOAD_RAW_BODY_LIMIT = '20mb';

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

  /**
   * POST /api/v1/images/upload (§18.4 step 4 "Paste or attach", CAM-15).
   * Raw body, not JSON or multipart — express.raw() here is scoped to this
   * one route so the app-wide express.json() limit/behavior for every other
   * route is untouched. The wildcard content-type matcher below means the
   * body is captured as a Buffer regardless of what Content-Type the client claims; sanitizePng() (via
   * uploadImage) is what actually decides whether it's a PNG, not the header.
   * Any `path`/`filename` field in the body or query is never read — the
   * object path comes only from scopeOf(req), i.e. the JWT (§4, ISO-15..19).
   */
  router.post('/upload', express.raw({ type: '*/*', limit: UPLOAD_RAW_BODY_LIMIT }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ValidationError('Expected a non-empty image body');
      }
      const result = await uploadImage(deps, scopeOf(req), req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
