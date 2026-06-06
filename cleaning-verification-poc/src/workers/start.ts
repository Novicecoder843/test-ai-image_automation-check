import { logger } from '../config/logger.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../queue/redis.js';
import { closeQueue } from '../queue/cleaning.queue.js';
import { startCleaningWorker, stopCleaningWorker } from './cleaning.worker.js';

/**
 * Standalone worker process.
 *   npm run start:worker
 *   npm run dev:worker
 *
 * Run this when you want to scale the worker independently of the API.
 * (In dev, `RUN_WORKER_IN_API=true` is enough.)
 */

startCleaningWorker();
logger.info('worker process running — Ctrl+C to stop');

async function shutdown(signal: string) {
  logger.warn({ signal }, 'shutting down worker process');
  await stopCleaningWorker().catch(() => {});
  await closeQueue();
  await closeRedis();
  await closePool().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
