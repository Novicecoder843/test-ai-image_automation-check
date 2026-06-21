import { readFileSync } from 'node:fs';
import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Redis connection (BullMQ requires `maxRetriesPerRequest: null`).
 * The client is shared between the queue and worker in this POC.
 */
function buildRedisOptions(): RedisOptions {
  const options: RedisOptions = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };

  if (env.REDIS_TLS) {
    options.tls = {
      rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
    };
    if (env.REDIS_TLS_CA) {
      options.tls.ca = readFileSync(env.REDIS_TLS_CA);
    }
    if (env.REDIS_TLS_SERVERNAME) {
      options.tls.servername = env.REDIS_TLS_SERVERNAME;
    }
  }

  return options;
}

const options = buildRedisOptions();

export const redis: Redis = new IORedis(options);

if (env.REDIS_TLS) {
  logger.info(
    {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
      hasCa: Boolean(env.REDIS_TLS_CA),
      servername: env.REDIS_TLS_SERVERNAME,
    },
    'redis TLS enabled'
  );
}

redis.on('ready', () => logger.info('redis ready'));
redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
redis.on('end', () => logger.warn('redis connection ended'));

export function getBullMQConnection(): RedisOptions {
  return options;
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => {});
}
