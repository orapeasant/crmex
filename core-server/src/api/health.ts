import { Router } from 'express';

/** GET /api/v1/health — the one route exempt from auth. */
export function createHealthRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return router;
}
