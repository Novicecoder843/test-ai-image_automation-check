import sharp from 'sharp';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middlewares/error-handler.js';

/**
 * Image quality gate.
 *
 * Runs AFTER preprocessing but BEFORE storage + embedding, for BOTH the admin
 * reference path and the janitor completion path. The goal is to stop
 * low-quality photos (blurry / too dark / overexposed / tiny / near-blank) from
 * silently producing a misleading FAIL during AI comparison.
 *
 * Why it matters:
 *   CLIP + the Vision LLM compare visual *content*. A bad photo lands far from
 *   the reference embedding → low cosine similarity → FAIL, even when the room
 *   is actually clean. By rejecting at upload time (HTTP 422) the janitor can
 *   re-shoot on the spot, and a weak admin reference can never poison every
 *   future comparison for that facility.
 *
 * All metrics come from sharp (`metadata()` + `stats()`), so there is no extra
 * dependency. Thresholds live in env (`IMG_QUALITY_*`) and can be tuned per
 * deployment; set `IMG_QUALITY_ENFORCE=false` to measure-and-log without
 * rejecting (recommended while calibrating on real data).
 */

export type QualityReason =
  | 'resolution_too_low'
  | 'too_few_pixels'
  | 'image_blurry'
  | 'image_too_dark'
  | 'image_overexposed'
  | 'image_low_detail'
  | 'file_too_small';

export interface QualityMetrics {
  width: number;
  height: number;
  megapixels: number;
  sharpness: number;
  brightness: number; // mean luma 0..255
  entropy: number;
  bytes: number;
}

export interface QualityReport {
  ok: boolean;
  reasons: QualityReason[];
  metrics: QualityMetrics;
}

/**
 * Compute quality metrics for an image buffer and compare them to the
 * configured thresholds. Pure measurement — never throws on a low-quality
 * image (use `enforceQuality` for that).
 */
export async function assessImageQuality(buffer: Buffer): Promise<QualityReport> {
  if (!buffer?.length) {
    throw new AppError('assessImageQuality: empty input buffer', {
      status: 400,
      stage: 'image-quality',
    });
  }

  let meta: sharp.Metadata;
  let stats: sharp.Stats;
  try {
    const pipeline = sharp(buffer, { failOn: 'truncated' });
    [meta, stats] = await Promise.all([pipeline.metadata(), sharp(buffer).stats()]);
  } catch (err) {
    throw new AppError(`Failed to analyse image quality: ${(err as Error).message}`, {
      status: 400,
      stage: 'image-quality',
      cause: err,
    });
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const megapixels = (width * height) / 1_000_000;
  const sharpness = stats.sharpness ?? 0;
  const entropy = stats.entropy ?? 0;

  // Mean luma ≈ average of the first three (RGB) channel means. Greyscale
  // images expose a single channel, so guard against that.
  const colourChannels = stats.channels.slice(0, 3);
  const brightness = colourChannels.length
    ? colourChannels.reduce((sum, c) => sum + c.mean, 0) / colourChannels.length
    : 0;

  const bytes = buffer.length;

  const reasons: QualityReason[] = [];
  if (Math.max(width, height) < env.IMG_QUALITY_MIN_DIMENSION) reasons.push('resolution_too_low');
  if (megapixels < env.IMG_QUALITY_MIN_MEGAPIXELS) reasons.push('too_few_pixels');
  if (sharpness < env.IMG_QUALITY_MIN_SHARPNESS) reasons.push('image_blurry');
  if (brightness < env.IMG_QUALITY_MIN_BRIGHTNESS) reasons.push('image_too_dark');
  if (brightness > env.IMG_QUALITY_MAX_BRIGHTNESS) reasons.push('image_overexposed');
  if (entropy < env.IMG_QUALITY_MIN_ENTROPY) reasons.push('image_low_detail');
  if (bytes < env.IMG_QUALITY_MIN_BYTES) reasons.push('file_too_small');

  return {
    ok: reasons.length === 0,
    reasons,
    metrics: {
      width,
      height,
      megapixels: Number(megapixels.toFixed(3)),
      sharpness: Number(sharpness.toFixed(2)),
      brightness: Number(brightness.toFixed(1)),
      entropy: Number(entropy.toFixed(2)),
      bytes,
    },
  };
}

const REASON_HINTS: Record<QualityReason, string> = {
  resolution_too_low: 'Move closer or use a higher-resolution camera setting.',
  too_few_pixels: 'Use a higher-resolution camera setting.',
  image_blurry: 'Hold the camera steady and let it focus before capturing.',
  image_too_dark: 'Turn on more lighting or the camera flash.',
  image_overexposed: 'Reduce direct light/glare or move away from the light source.',
  image_low_detail: 'Make sure the area to inspect fills the frame.',
  file_too_small: 'Retake the photo at full quality.',
};

/**
 * Enforce the quality gate.
 *
 * When `IMG_QUALITY_ENFORCE=true` and the report is not ok, throws an
 * `AppError` (HTTP 422) carrying a machine-readable code, the failing reasons,
 * the measured metrics, and an actionable hint. When enforcement is off it only
 * logs a warning so you can calibrate thresholds against real uploads.
 *
 * @param context  free-form tag for logs, e.g. 'admin' | 'janitor'
 */
export function enforceQuality(report: QualityReport, context: string): void {
  if (report.ok) return;

  if (!env.IMG_QUALITY_ENFORCE) {
    logger.warn(
      { stage: 'image-quality', context, reasons: report.reasons, metrics: report.metrics },
      'image-quality: low quality (warn-only, not enforced)'
    );
    return;
  }

  logger.warn(
    { stage: 'image-quality', context, reasons: report.reasons, metrics: report.metrics },
    'image-quality: rejected low-quality image'
  );

  const hint =
    report.reasons.map((r) => REASON_HINTS[r]).find(Boolean) ??
    'Hold steady, ensure good lighting, and frame the same area as the reference.';

  throw new AppError('Image quality too low — please retake the photo', {
    status: 422,
    stage: 'image-quality',
    details: {
      code: 'LOW_QUALITY_IMAGE',
      reasons: report.reasons,
      metrics: report.metrics,
      hint,
    },
  });
}

/**
 * Convenience: assess + enforce in one call. Returns the report (useful for
 * logging / surfacing metrics in the response even on the happy path).
 */
export async function checkImageQuality(buffer: Buffer, context: string): Promise<QualityReport> {
  const report = await assessImageQuality(buffer);
  enforceQuality(report, context);
  return report;
}
