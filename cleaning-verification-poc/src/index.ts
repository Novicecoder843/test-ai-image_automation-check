import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool, closePool } from './db/pool.js';
import { closeRedis } from './queue/redis.js';
import { closeQueue } from './queue/cleaning.queue.js';
import { startCleaningWorker, stopCleaningWorker } from './workers/cleaning.worker.js';

/**
 * API entrypoint.
 *   npm run dev    (watch)
 *   npm run start  (one-shot)
 *
 * When RUN_WORKER_IN_API=true (default in .env.example), the BullMQ worker
 * is also started in this process so a single `npm run dev` is enough for
 * full end-to-end testing.
 */

async function main() {
  // Fail fast if DB is unreachable
  try {
    const r = await pool.query('SELECT current_database() AS db, version() AS version');
    logger.info({ db: r.rows[0]?.db, pgVersion: r.rows[0]?.version?.split(' ')[1] }, 'postgres connected');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'postgres unreachable — exiting');
    process.exit(1);
  }

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, storage: env.STORAGE_DRIVER }, 'API listening');
  });

  if (env.RUN_WORKER_IN_API) {
    startCleaningWorker();
  } else {
    logger.warn('RUN_WORKER_IN_API=false — run `npm run start:worker` separately');
  }

  async function shutdown(signal: string) {
    logger.warn({ signal }, 'shutting down API');
    server.close();
    if (env.RUN_WORKER_IN_API) await stopCleaningWorker().catch(() => {});
    await closeQueue();
    await closeRedis();
    await closePool().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal');
  process.exit(1);
});
