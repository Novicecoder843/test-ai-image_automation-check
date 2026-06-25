import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/**
 * CLIP image embedding service.
 */

export const CLIP_EMBEDDING_DIM = 512;

type ExtractorOutput = { data: Float32Array | number[]; dims?: number[] };
type Extractor = (image: unknown, options?: Record<string, unknown>) => Promise<ExtractorOutput>;
interface RawImageStatic {
  fromURL: (url: string) => Promise<unknown>;
  fromBlob: (blob: Blob) => Promise<unknown>;
}

let extractorPromise: Promise<{ extractor: Extractor; RawImage: RawImageStatic }> | null = null;

async function loadExtractor() {
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    try {
      logger.info({ model: env.CLIP_MODEL_NAME }, 'loading CLIP model');
      const mod: any = await import('@xenova/transformers');
      const { pipeline, RawImage, env: tEnv } = mod;
      if (tEnv) {
        tEnv.allowLocalModels = tEnv.allowLocalModels ?? true;
        tEnv.useBrowserCache = false;
      }
      const extractor = (await pipeline(
        'image-feature-extraction',
        env.CLIP_MODEL_NAME
      )) as Extractor;
      logger.info({ model: env.CLIP_MODEL_NAME }, 'CLIP model ready');
      return { extractor, RawImage: RawImage as RawImageStatic };
    } catch (err) {
      // Reset so the next request can retry (e.g. transient HF outage)
      extractorPromise = null;
      logger.error({ err: (err as Error).message }, 'failed to load CLIP model');
      throw err;
    }
  })();

  return extractorPromise;
}

function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] ?? 0;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

async function embedRawImage(image: unknown): Promise<number[]> {
  const { extractor } = await loadExtractor();
  const output = await extractor(image, { pooling: 'mean', normalize: true });
  const raw = Array.from(output.data as Float32Array);
  if (raw.length !== CLIP_EMBEDDING_DIM) {
    logger.warn({ expected: CLIP_EMBEDDING_DIM, got: raw.length }, 'CLIP embedding length mismatch');
  }
  return l2Normalize(raw);
}

/**
 * Generate an L2-normalized CLIP embedding for an image URL.
 */
export async function generateImageEmbeddingFromUrl(imageUrl: string): Promise<number[]> {
  if (!imageUrl) throw new Error('imageUrl is required');
  const { RawImage } = await loadExtractor();

  let image: unknown;
  try {
    image = await RawImage.fromURL(imageUrl);
  } catch (err) {
    const safeUrl = imageUrl.startsWith('data:') ? `data:[${imageUrl.length} chars]` : imageUrl;
    throw new Error(`Failed to load image (${safeUrl}): ${(err as Error).message}`);
  }

  return embedRawImage(image);
}

/**
 * Generate an embedding from a raw image buffer.
 */
export async function generateImageEmbeddingFromBuffer(
  buffer: Buffer,
  mimeType = 'image/jpeg'
): Promise<number[]> {
  if (!buffer?.length) throw new Error('buffer is required');
  const { RawImage } = await loadExtractor();

  let image: unknown;
  try {
    const blob = new Blob([buffer], { type: mimeType });
    image = await RawImage.fromBlob(blob);
  } catch (err) {
    throw new Error(`Failed to decode image buffer (${mimeType}): ${(err as Error).message}`);
  }

  return embedRawImage(image);
}

// Format for pgvector
export function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

export function parsePgVectorLiteral(value: string | number[] | null | undefined): number[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number);
  const trimmed = String(value).trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
}
