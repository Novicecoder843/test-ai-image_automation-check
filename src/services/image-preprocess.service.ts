import sharp from 'sharp';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middlewares/error-handler.js';

/**
 * Preprocesses images before storage and AI embedding.
 * Resizes, strips metadata, and normalizes format to ensure consistency
 * between reference and completion images.
 */

// Process configuration once at boot — sharp tuning is global.
sharp.cache(false);                                     // multi-process safety
sharp.concurrency(Math.max(1, Math.min(4, env.WORKER_CONCURRENCY)));
sharp.simd(true);

export interface PreprocessResult {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  bytes: number;
  format: 'jpeg' | 'webp';
  durationMs: number;
  source: {
    format?: string;
    width?: number;
    height?: number;
    bytes: number;
  };
}

export interface PreprocessOptions {
  /** Override the env default (e.g. 224 for CLIP-only branch). */
  maxDimension?: number;
  /** Override the env quality. */
  quality?: number;
  /** Override the env format. */
  format?: 'jpeg' | 'webp';
}

/**
 * Run an upload buffer through the full preprocessing pipeline.
 * Throws an `AppError` with stage `image-preprocess` on any failure so
 * the existing error handler tags the response correctly.
 */
export async function preprocessImage(
  input: Buffer,
  opts: PreprocessOptions = {}
): Promise<PreprocessResult> {
  if (!input?.length) {
    throw new AppError('preprocessImage: empty input buffer', {
      status: 400,
      stage: 'image-preprocess',
    });
  }

  const startedAt = Date.now();
  const maxDimension = opts.maxDimension ?? env.IMG_MAX_DIMENSION;
  const quality = opts.quality ?? env.IMG_OUTPUT_QUALITY;
  const format = opts.format ?? env.IMG_OUTPUT_FORMAT;

  let pipeline: sharp.Sharp;
  let metadata: sharp.Metadata;
  try {
    pipeline = sharp(input, {
      // Decompression-bomb guard: refuse images that would expand into
      // more than IMG_DECODE_PIXEL_LIMIT raw pixels.
      limitInputPixels: env.IMG_DECODE_PIXEL_LIMIT,
      sequentialRead: true,
      failOn: 'truncated',
    });
    metadata = await pipeline.metadata();
  } catch (err) {
    throw new AppError(`Failed to decode image: ${(err as Error).message}`, {
      status: 400,
      stage: 'image-preprocess',
      cause: err,
    });
  }

  // Pipeline construction
  pipeline = pipeline
    .rotate()                                 // EXIF auto-orient
    .toColorspace('srgb')
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',                          // preserve aspect, no crop
      withoutEnlargement: true,               // don't upscale tiny refs
    });

  let outBuf: Buffer;
  let outInfo: sharp.OutputInfo;
  try {
    if (format === 'webp') {
      const out = await pipeline
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
      outBuf = out.data;
      outInfo = out.info;
    } else {
      const out = await pipeline
        .jpeg({
          quality,
          mozjpeg: true,                      // ~10% smaller than libjpeg-turbo
          progressive: true,                  // better perceived load on web
          chromaSubsampling: '4:2:0',
          trellisQuantisation: true,
          overshootDeringing: true,
        })
        .toBuffer({ resolveWithObject: true });
      outBuf = out.data;
      outInfo = out.info;
    }
  } catch (err) {
    throw new AppError(`Failed to re-encode image: ${(err as Error).message}`, {
      status: 500,
      stage: 'image-preprocess',
      cause: err,
    });
  }

  const result: PreprocessResult = {
    buffer: outBuf,
    mimeType: format === 'webp' ? 'image/webp' : 'image/jpeg',
    width: outInfo.width,
    height: outInfo.height,
    bytes: outBuf.length,
    format,
    durationMs: Date.now() - startedAt,
    source: {
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      bytes: input.length,
    },
  };

  logger.info(
    {
      stage: 'image-preprocess',
      durationMs: result.durationMs,
      source: result.source,
      output: {
        format: result.format,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
      },
      compressionRatio: result.source.bytes
        ? Number((result.source.bytes / result.bytes).toFixed(2))
        : null,
    },
    'preprocessed image'
  );

  return result;
}

/**
 * Build the storage object key extension from the chosen output format.
 * The caller already has a `<prefix>_<ts>_<rand>_<safeName>` key; this
 * normalises the extension so what we store on disk matches the mimetype
 * we recorded in the DB.
 */
export function normaliseKeyExtension(key: string, format: 'jpeg' | 'webp'): string {
  const desiredExt = format === 'webp' ? 'webp' : 'jpg';
  const dot = key.lastIndexOf('.');
  if (dot < 0 || dot < key.lastIndexOf('/')) return `${key}.${desiredExt}`;
  return `${key.slice(0, dot)}.${desiredExt}`;
}
