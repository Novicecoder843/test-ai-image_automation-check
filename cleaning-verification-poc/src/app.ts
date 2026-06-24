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

  // Request & Response log
  app.use((req, res, next) => {
    const start = Date.now();
    logger.info({ method: req.method, url: req.originalUrl }, 'incoming request');
    
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      logger.info(
        { method: req.method, url: req.originalUrl, status: res.statusCode, durationMs },
        'request completed'
      );
    });
    
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

  // Simple upload + compare UI (static)
  const publicDir = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
