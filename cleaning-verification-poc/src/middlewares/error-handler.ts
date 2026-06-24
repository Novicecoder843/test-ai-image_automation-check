import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

/**
 * Application error with optional HTTP status + stage tag.
 * Throw this from controllers/services to control the response shape.
 */
export class AppError extends Error {
  status: number;
  stage?: string;
  details?: unknown;
  constructor(message: string, opts?: { status?: number; stage?: string; details?: unknown; cause?: unknown }) {
    super(message);
    this.status = opts?.status ?? 500;
    this.stage = opts?.stage;
    this.details = opts?.details;
    if (opts?.cause) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({ success: false, error: `Not Found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (err, req: Request, res: Response, _next: NextFunction) => {
  const status = (err as AppError).status ?? 500;
  const stage = (err as AppError).stage;
  const message = err?.message ?? 'Unknown error';

  logger.error(
    {
      method: req.method,
      url: req.originalUrl,
      stage,
      err: message,
      stack: err?.stack,
      cause: (err as { cause?: { message?: string } })?.cause?.message,
    },
    'request failed'
  );

  // Mirror to stderr so it's visible even when log level is quiet
  console.error(`[${req.method} ${req.originalUrl}] ${stage ? `[${stage}] ` : ''}${message}`);
  if (err?.stack) console.error(err.stack);

  res.status(status).json({
    success: false,
    error: stage ? `[${stage}] ${message}` : message,
    details: (err as AppError).details ?? undefined,
  });
};
