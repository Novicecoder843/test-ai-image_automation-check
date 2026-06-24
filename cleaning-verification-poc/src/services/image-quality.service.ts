import sharp from 'sharp';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middlewares/error-handler.js';

/**
 * Image quality gate.
 * Validates images against configured quality thresholds (resolution, sharpness, brightness, entropy)
 * before processing to prevent poor quality uploads from causing false verification failures.
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

/**
 * Minimum upload requirements for mobile clients (phone photos).
 * Values mirror env defaults — call at runtime so deployments stay in sync.
 */
export function getUploadRequirements() {
  return {
    upload: {
      max_size_mb: env.IMG_MAX_UPLOAD_MB,
      allowed_mime_types: env.IMG_ALLOW_HEIC
        ? ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
        : ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
    },
    preprocess: {
      max_dimension_px: env.IMG_MAX_DIMENSION,
      output_format: env.IMG_OUTPUT_FORMAT,
      output_quality: env.IMG_OUTPUT_QUALITY,
    },
    quality_gate: {
      enforce: env.IMG_QUALITY_ENFORCE,
      min_dimension_px: env.IMG_QUALITY_MIN_DIMENSION,
      min_megapixels: env.IMG_QUALITY_MIN_MEGAPIXELS,
      min_sharpness: env.IMG_QUALITY_MIN_SHARPNESS,
      min_brightness: env.IMG_QUALITY_MIN_BRIGHTNESS,
      max_brightness: env.IMG_QUALITY_MAX_BRIGHTNESS,
      min_entropy: env.IMG_QUALITY_MIN_ENTROPY,
      min_bytes: env.IMG_QUALITY_MIN_BYTES,
    },
    scene_match: {
      enforce: env.SCENE_MATCH_ENFORCE,
      min_similarity: env.SCENE_MATCH_MIN_SIMILARITY,
      strict_template: env.SCENE_MATCH_STRICT_TEMPLATE,
      template_id_required: env.SCENE_MATCH_ENFORCE,
    },
    ai: {
      clip_model: env.CLIP_MODEL_NAME,
      vision_provider: env.VISION_PROVIDER,
      embedding_dimensions: 512,
    },
    decision_thresholds: {
      similarity_pass: env.CLEANING_SIMILARITY_PASS_THRESHOLD,
      similarity_fail: env.CLEANING_SIMILARITY_FAIL_THRESHOLD,
      scene_match_min: env.SCENE_MATCH_MIN_SIMILARITY,
      vision_pass_score: env.CLEANING_VISION_PASS_SCORE,
      vision_fail_score: env.CLEANING_VISION_FAIL_SCORE,
      vision_review_score: env.CLEANING_VISION_REVIEW_SCORE,
    },
    tips: [
      'Hold the camera steady and ensure good lighting.',
      'Frame the same area as the task reference photo.',
      'Use the highest quality setting on your phone camera.',
      'template_id must match the task type (e.g. washroom=168, corridor=101).',
    ],
  };
}
