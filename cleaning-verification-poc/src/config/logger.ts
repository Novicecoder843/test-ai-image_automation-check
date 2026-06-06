import pino from 'pino';
import { env } from './env.js';

/**
 * Application logger.
 * In dev, pino-pretty turns the JSON into colored single-line logs.
 * In prod (NODE_ENV=production), structured JSON is emitted as-is.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'cleaning-verification-poc' },
  ...(env.NODE_ENV === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service',
          },
        },
      }),
});
