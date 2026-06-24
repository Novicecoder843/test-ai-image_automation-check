import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, closePool } from './pool.js';
import { logger } from '../config/logger.js';

/**
 * Minimal SQL migration runner.
 * - Reads every *.sql file from db/migrations/ alphabetically
 * - Skips files already recorded in `schema_migrations`
 * - Applies the remaining files in a single transaction each
 *
 * Usage: `npm run migrate`
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((r) => r.name));
}

async function applyMigration(file: string): Promise<void> {
  const fullPath = path.join(MIGRATIONS_DIR, file);
  const sql = await readFile(fullPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    logger.info({ migration: file }, 'migration applied');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  logger.info({ dir: MIGRATIONS_DIR }, 'running migrations');
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ migration: file }, 'already applied — skipping');
      continue;
    }
    await applyMigration(file);
    appliedCount += 1;
  }

  logger.info({ appliedCount, totalFiles: files.length }, 'migrations finished');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'migration failed');
    console.error(err);
    await closePool().catch(() => {});
    process.exit(1);
  });
