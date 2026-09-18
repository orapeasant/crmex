import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

/** Uniform error shape for every non-2xx response: { error: { code, message } }. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request body' } });
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error in core-server:', err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
