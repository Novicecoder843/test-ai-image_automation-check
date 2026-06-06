import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Redis connection (BullMQ requires `maxRetriesPerRequest: null`).
 * The client is shared between the queue and worker in this POC.
 */
const options: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

export const redis: Redis = new IORedis(options);

redis.on('ready', () => logger.info('redis ready'));
redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
redis.on('end', () => logger.warn('redis connection ended'));

export function getBullMQConnection(): RedisOptions {
  return options;
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => {});
}
