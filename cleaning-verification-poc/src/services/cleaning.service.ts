import { logger } from '../config/logger.js';
import { uploadBuffer, getPublicUrl } from '../storage/index.js';
import { generateImageEmbeddingFromBuffer } from './embedding.service.js';
import { preprocessImage, normaliseKeyExtension } from './image-preprocess.service.js';
import { checkImageQuality } from './image-quality.service.js';
import * as referenceRepo from '../repositories/cleaning-reference.repo.js';
import * as verificationRepo from '../repositories/cleaning-verification.repo.js';
import { enqueueCleaningVerification } from '../queue/cleaning.queue.js';
import { AppError } from '../middlewares/error-handler.js';

/**
 * Cleaning orchestrator — the only place HTTP handlers talk to.
 *
 *   adminUploadReference: synchronous (preprocess + upload + embed + persist)
 *   janitorUploadCompletion: queue-based (preprocess + upload + PENDING row → BullMQ job → worker)
 *   getTaskVerificationResult: latest row from DB
 *
 * Preprocessing note:
 *   We run every upload through sharp BEFORE both storage and embedding, so
 *   what's persisted on disk is exactly what was vectorised. That removes a
 *   subtle source of drift (admin uploads 12 MP HEIC, janitor uploads 8 MP
 *   JPEG → CLIP sees two different colour-spaces / orientations).
 */

const REFERENCE_FOLDER = 'cleaning/references';
const COMPLETION_FOLDER = 'cleaning/completions';

function buildObjectKey(folder: string, prefix: string, originalName: string): string {
  const safe = (originalName || 'image').replace(/[^\w.\-]+/g, '_');
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${folder}/${prefix}_${ts}_${rand}_${safe}`;
}

// ─── Admin upload reference ─────────────────────────────────────────────

export interface AdminUploadInput {
  facility_id: number;
  template_id?: number | null;
  label?: string | null;
  uploaded_by?: string | null;
  file: Express.Multer.File;
}

export interface AdminUploadResult {
  id: number;
  facility_id: number;
  template_id: number | null;
  image_path: string;
  image_url: string;
  image_mime: string;
  image_width: number;
  image_height: number;
  image_bytes: number;
  label: string | null;
  embedding_dim: number;
  preprocess_ms: number;
  source_bytes: number;
}

export async function adminUploadReference(
  input: AdminUploadInput
): Promise<AdminUploadResult> {
  const { facility_id, template_id, label, uploaded_by, file } = input;

  if (!file?.buffer?.length) {
    throw new AppError('Reference image file is required', { status: 400, stage: 'validate' });
  }

  // 1. Preprocess (sharp): EXIF rotate → sRGB → resize → re-encode → strip metadata
  const preprocessed = await preprocessImage(file.buffer);

  // 1b. Quality gate — reject blurry/dark/tiny references (HTTP 422) before we
  // store or embed. A weak reference would poison every future comparison for
  // this facility.
  // await checkImageQuality(preprocessed.buffer, 'admin');

  // 2. Upload preprocessed bytes to storage
  let storedKey: string;
  let publicUrl: string;
  try {
    const rawKey = buildObjectKey(REFERENCE_FOLDER, `f${facility_id}`, file.originalname);
    const key = normaliseKeyExtension(rawKey, preprocessed.format);
    storedKey = await uploadBuffer(preprocessed.buffer, key, preprocessed.mimeType);
    publicUrl = getPublicUrl(storedKey);
    logger.info(
      { facility_id, storedKey, bytes: preprocessed.bytes },
      'reference uploaded'
    );
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'storage-upload', cause: err });
  }

  // 3. CLIP embedding — generated from the SAME bytes we just stored
  let embedding: number[];
  try {
    embedding = await generateImageEmbeddingFromBuffer(
      preprocessed.buffer,
      preprocessed.mimeType
    );
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(`CLIP returned empty embedding (length=${embedding?.length})`);
    }
    logger.info({ facility_id, dim: embedding.length }, 'reference embedded');
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'clip-embedding', cause: err });
  }

  // 4. DB insert
  let inserted: Awaited<ReturnType<typeof referenceRepo.insertReference>>;
  try {
    inserted = await referenceRepo.insertReference({
      facility_id,
      template_id: template_id ?? null,
      label: label ?? null,
      image_path: storedKey,
      image_url: publicUrl,
      image_mime: preprocessed.mimeType,
      image_width: preprocessed.width,
      image_height: preprocessed.height,
      image_bytes: preprocessed.bytes,
      embedding,
      uploaded_by: uploaded_by ?? null,
    });
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'db-insert', cause: err });
  }

  return {
    id: inserted.id,
    facility_id: inserted.facility_id,
    template_id: inserted.template_id,
    image_path: inserted.image_path,
    image_url: inserted.image_url ?? publicUrl,
    image_mime: preprocessed.mimeType,
    image_width: preprocessed.width,
    image_height: preprocessed.height,
    image_bytes: preprocessed.bytes,
    label: inserted.label,
    embedding_dim: embedding.length,
    preprocess_ms: preprocessed.durationMs,
    source_bytes: preprocessed.source.bytes,
  };
}

// ─── Janitor upload completion ──────────────────────────────────────────

export interface JanitorUploadInput {
  task_id: number;
  facility_id: number;
  template_id?: number | null;
  janitor_id?: string | null;
  file: Express.Multer.File;
}

export interface JanitorUploadResult {
  verification_id: number;
  task_id: number;
  status: 'PENDING';
  image_path: string;
  image_url: string;
  image_mime: string;
  image_width: number;
  image_height: number;
  image_bytes: number;
  bull_job_id: string;
  queued_at: string;
  preprocess_ms: number;
  source_bytes: number;
}

export async function janitorUploadCompletion(
  input: JanitorUploadInput
): Promise<JanitorUploadResult> {
  const { task_id, facility_id, template_id, janitor_id, file } = input;
  if (!file?.buffer?.length) {
    throw new AppError('Completion image file is required', { status: 400, stage: 'validate' });
  }

  // 1. Preprocess (same pipeline as admin path — keeps comparisons consistent)
  const preprocessed = await preprocessImage(file.buffer);

  // 1b. Quality gate — reject blurry/dark/tiny completion photos (HTTP 422)
  // before we store/queue. Stops the janitor from getting a misleading FAIL
  // caused by a bad photo rather than a bad cleaning job.
  // await checkImageQuality(preprocessed.buffer, 'janitor');

  // 2. Upload preprocessed bytes
  let storedKey: string;
  let publicUrl: string;
  try {
    const rawKey = buildObjectKey(
      COMPLETION_FOLDER,
      `t${task_id}_f${facility_id}`,
      file.originalname
    );
    const key = normaliseKeyExtension(rawKey, preprocessed.format);
    storedKey = await uploadBuffer(preprocessed.buffer, key, preprocessed.mimeType);
    publicUrl = getPublicUrl(storedKey);
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'storage-upload', cause: err });
  }

  // 3. Insert PENDING row
  let pending: Awaited<ReturnType<typeof verificationRepo.createPending>>;
  try {
    pending = await verificationRepo.createPending({
      task_id,
      facility_id,
      template_id: template_id ?? null,
      janitor_id: janitor_id ?? null,
      image_path: storedKey,
      image_url: publicUrl,
      image_mime: preprocessed.mimeType,
      image_width: preprocessed.width,
      image_height: preprocessed.height,
      image_bytes: preprocessed.bytes,
    });
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'db-insert', cause: err });
  }

  // 4. Enqueue
  let jobId: string;
  try {
    const job = await enqueueCleaningVerification({
      verification_id: pending.id,
      task_id,
      facility_id,
      template_id: template_id ?? null,
      janitor_id: janitor_id ?? null,
      uploaded_image_path: storedKey,
      uploaded_image_url: publicUrl,
      uploaded_image_mime: preprocessed.mimeType,
    });
    jobId = String(job.id ?? '');
    await verificationRepo.attachJobId(pending.id, jobId).catch(() => {});
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'queue-enqueue', cause: err });
  }

  return {
    verification_id: pending.id,
    task_id,
    status: 'PENDING',
    image_path: storedKey,
    image_url: publicUrl,
    image_mime: preprocessed.mimeType,
    image_width: preprocessed.width,
    image_height: preprocessed.height,
    image_bytes: preprocessed.bytes,
    bull_job_id: jobId,
    queued_at: new Date().toISOString(),
    preprocess_ms: preprocessed.durationMs,
    source_bytes: preprocessed.source.bytes,
  };
}

// ─── Result lookup ──────────────────────────────────────────────────────

export async function getTaskVerificationResult(task_id: number) {
  const row = await verificationRepo.getLatestByTaskId(task_id);
  if (!row) return null;
  return {
    verification_id: row.id,
    task_id: row.task_id,
    facility_id: row.facility_id,
    template_id: row.template_id,
    reference_id: row.reference_id,
    status: row.status,
    image_url: row.image_url,
    similarity_score: row.similarity_score,
    vision: {
      passed: row.vision_passed,
      score: row.vision_score,
      confidence: row.vision_confidence,
      issues: row.vision_issues ?? [],
    },
    rule_reason: row.rule_reason,
    error_message: row.error_message,
    bull_job_id: row.bull_job_id,
    created_at: row.created_at,
    processed_at: row.processed_at,
  };
}

export async function getTaskVerificationHistory(task_id: number) {
  const rows = await verificationRepo.getAllByTaskId(task_id);
  return rows.map((row) => ({
    verification_id: row.id,
    status: row.status,
    similarity_score: row.similarity_score,
    vision: {
      passed: row.vision_passed,
      score: row.vision_score,
      confidence: row.vision_confidence,
      issues: row.vision_issues ?? [],
    },
    created_at: row.created_at,
    processed_at: row.processed_at,
  }));
}
