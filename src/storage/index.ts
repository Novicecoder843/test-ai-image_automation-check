import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '@google-cloud/storage';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Storage adapter.
 *
 * Two drivers, selected via STORAGE_DRIVER:
 *   - `local` → writes under ./uploads, served by the API at /files/<key>
 *   - `gcs`   → writes to a Google Cloud Storage bucket
 *
 * Public API:
 *   - uploadBuffer(buffer, key, mimeType)  → object key (no host)
 *   - getPublicUrl(key)                    → absolute URL for the key
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.resolve(__dirname, '../../uploads');

let gcsBucket: ReturnType<Storage['bucket']> | null = null;
if (env.STORAGE_DRIVER === 'gcs') {
  if (!env.GCS_BUCKET_NAME) {
    throw new Error('STORAGE_DRIVER=gcs but GCS_BUCKET_NAME is not set');
  }
  const storage = new Storage(
    env.GOOGLE_APPLICATION_CREDENTIALS
      ? { keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS }
      : undefined
  );
  gcsBucket = storage.bucket(env.GCS_BUCKET_NAME);
  logger.info({ bucket: env.GCS_BUCKET_NAME }, 'storage: GCS adapter ready');
} else {
  logger.info({ root: LOCAL_ROOT }, 'storage: local adapter ready');
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, '');
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Upload a buffer and return the stored object key (caller saves this to DB).
 */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  _mimeType: string
): Promise<string> {
  const normalized = normalizeKey(key);
  if (env.STORAGE_DRIVER === 'gcs') {
    if (!gcsBucket) throw new Error('GCS bucket not initialized');
    const blob = gcsBucket.file(normalized);
    await blob.save(buffer, {
      contentType: _mimeType,
      metadata: { cacheControl: 'public, max-age=31536000' },
    });
    return normalized;
  }
  const fullPath = path.join(LOCAL_ROOT, normalized);
  await ensureDir(fullPath);
  await fs.writeFile(fullPath, buffer);
  return normalized;
}

/**
 * Resolve an object key to a publicly fetchable URL.
 * (GPT-4o Vision and CLIP can both fetch http(s) URLs.)
 */
export function getPublicUrl(key: string): string {
  const normalized = normalizeKey(key);
  if (env.STORAGE_DRIVER === 'gcs') {
    if (env.GCS_BASE_URL) return `${env.GCS_BASE_URL.replace(/\/$/, '')}/${normalized}`;
    return `https://storage.googleapis.com/${env.GCS_BUCKET_NAME}/${normalized}`;
  }
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/files/${normalized}`;
}

/**
 * Return absolute disk path for the local driver (used by the static handler).
 */
export function getLocalAbsolutePath(key: string): string {
  return path.join(LOCAL_ROOT, normalizeKey(key));
}

export const LOCAL_UPLOAD_ROOT = LOCAL_ROOT;
