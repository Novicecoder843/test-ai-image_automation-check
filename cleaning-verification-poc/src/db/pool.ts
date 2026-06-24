import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * PostgreSQL connection pool (shared across the process).
 */
export const pool = new pg.Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  database: env.PGDATABASE,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'pg idle client error');
});

/**
 * Convenience wrapper that always releases the client and logs SQL on error.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    return await client.query<T>(text, params as never);
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string; detail?: string };
    logger.error({ err: e.message, code: e.code, detail: e.detail, sql: text }, 'pg query failed');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
