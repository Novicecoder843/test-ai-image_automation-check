import express, { type Express } from 'express';
import path from 'node:path';
import { logger } from './config/logger.js';
import { env } from './config/env.js';
import { LOCAL_UPLOAD_ROOT } from './storage/index.js';
import apiRouter from './routes/index.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';

/**
 * Build the Express app (no listening here — `src/index.ts` does that).
 */
export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request log
  app.use((req, _res, next) => {
    logger.info({ method: req.method, url: req.originalUrl }, 'incoming request');
    next();
  });

  // Serve local-driver uploads at /files/* so vision + CLIP can fetch them
  if (env.STORAGE_DRIVER === 'local') {
    app.use(
      '/files',
      express.static(LOCAL_UPLOAD_ROOT, {
        fallthrough: false,
        maxAge: '1y',
        index: false,
      })
    );
    logger.info({ mount: '/files', root: LOCAL_UPLOAD_ROOT }, 'local storage exposed via static handler');
  }

  // API
  app.use('/api', apiRouter);

  // Root → tiny help text
  app.get('/', (_req, res) => {
    res.json({
      name: 'cleaning-verification-poc',
      docs: {
        admin_upload_reference: 'POST /api/admin/upload-reference',
        janitor_upload_completion: 'POST /api/janitor/upload-completion',
        upload_requirements: 'GET /api/upload-requirements',
        task_result: 'GET /api/tasks/:taskId/result',
        health: 'GET /api/health',
        queue_stats: 'GET /api/queue-stats',
      },
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
