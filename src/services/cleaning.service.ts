import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { uploadBuffer, getPublicUrl } from '../storage/index.js';
import { generateImageEmbeddingFromBuffer } from './embedding.service.js';
import { preprocessImage, normaliseKeyExtension } from './image-preprocess.service.js';
import { checkImageQuality, getUploadRequirements, type QualityMetrics } from './image-quality.service.js';
import { assessSceneMatch, enforceSceneMatch } from './scene-match.service.js';
import * as referenceRepo from '../repositories/cleaning-reference.repo.js';
import * as verificationRepo from '../repositories/cleaning-verification.repo.js';
import { enqueueCleaningVerification } from '../queue/cleaning.queue.js';
import { AppError } from '../middlewares/error-handler.js';

/**
 * Cleaning orchestrator — the only place HTTP handlers talk to.
 *
 *   adminUploadReference: synchronous (preprocess + quality + upload + embed + persist)
 *   janitorUploadCompletion: sync scene match + queue-based verification
 *   getTaskVerificationResult: latest row from DB
 */

const REFERENCE_FOLDER = 'cleaning/references';
const COMPLETION_FOLDER = 'cleaning/completions';

function buildObjectKey(folder: string, prefix: string, originalName: string): string {
  const safe = (originalName || 'image').replace(/[^\w.\-]+/g, '_');
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${folder}/${prefix}_${ts}_${rand}_${safe}`;
}

export function fetchUploadRequirements() {
  return getUploadRequirements();
}

// ─── Admin upload reference ─────────────────────────────────────────────

export interface AdminUploadInput {
  facility_id: number;
  template_id?: number | null;
  label?: string | null;
  uploaded_by?: string | null;
  file: Express.Multer.File;
  batch_id?: string;
}

export interface AdminUploadResult {
  id: number;
  batch_id: string | null;
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
  quality: QualityMetrics;
}

export async function adminUploadReference(
  input: AdminUploadInput
): Promise<AdminUploadResult> {
  const { facility_id, template_id, label, uploaded_by, file, batch_id } = input;

  if (!file?.buffer?.length) {
    throw new AppError('Reference image file is required', { status: 400, stage: 'validate' });
  }

  if (env.SCENE_MATCH_ENFORCE && template_id == null) {
    logger.warn(
      { facility_id },
      'admin upload: template_id missing — strongly recommended for task-type matching'
    );
  }

  const preprocessed = await preprocessImage(file.buffer);
  const qualityReport = await checkImageQuality(preprocessed.buffer, 'admin');

  let storedKey: string;
  let publicUrl: string;
  try {
    const rawKey = buildObjectKey(REFERENCE_FOLDER, `f${facility_id}`, file.originalname);
    const key = normaliseKeyExtension(rawKey, preprocessed.format);
    storedKey = await uploadBuffer(preprocessed.buffer, key, preprocessed.mimeType);
    publicUrl = getPublicUrl(storedKey);
    logger.info({ facility_id, storedKey, bytes: preprocessed.bytes }, 'reference uploaded');
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'storage-upload', cause: err });
  }

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
      batch_id: batch_id ?? null,
    });
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'db-insert', cause: err });
  }

  return {
    id: inserted.id,
    batch_id: inserted.batch_id ?? null,
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
    quality: qualityReport.metrics,
  };
}

// ─── Janitor upload completion ──────────────────────────────────────────

export interface JanitorUploadInput {
  task_id: number;
  facility_id: number;
  template_id?: number | null;
  janitor_id?: string | null;
  file: Express.Multer.File;
  batch_id?: string;
}

export interface JanitorUploadResult {
  verification_id: number;
  batch_id: string | null;
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
  quality: QualityMetrics;
  scene_match_percent: number;
  matched_reference_id: number;
}

export async function janitorUploadCompletion(
  input: JanitorUploadInput
): Promise<JanitorUploadResult> {
  const { task_id, facility_id, template_id, janitor_id, file, batch_id } = input;
  if (!file?.buffer?.length) {
    throw new AppError('Completion image file is required', { status: 400, stage: 'validate' });
  }

  if (env.SCENE_MATCH_ENFORCE && template_id == null) {
    throw new AppError('template_id is required for task matching', {
      status: 400,
      stage: 'validate',
      details: { code: 'TEMPLATE_ID_REQUIRED' },
    });
  }

  const preprocessed = await preprocessImage(file.buffer);
  const qualityReport = await checkImageQuality(preprocessed.buffer, 'janitor');

  // Scene match (sync) — before storage so wrong-area photos leave no side effects
  let sceneMatchPercent = 0;
  let matchedReferenceId = 0;

  if (env.SCENE_MATCH_ENFORCE) {
    const references = await referenceRepo.getReferencesForSceneMatch(
      facility_id,
      template_id ?? null
    );
    let uploadedEmbedding: number[];
    try {
      uploadedEmbedding = await generateImageEmbeddingFromBuffer(
        preprocessed.buffer,
        preprocessed.mimeType
      );
    } catch (err) {
      throw new AppError((err as Error).message, { stage: 'clip-embedding', cause: err });
    }

    const sceneResult = assessSceneMatch(uploadedEmbedding, references);
    enforceSceneMatch(sceneResult, { facility_id, template_id: template_id ?? null });
    sceneMatchPercent = Number((sceneResult.similarity * 100).toFixed(1));
    matchedReferenceId = sceneResult.referenceId;
    logger.info(
      { task_id, template_id, sceneMatchPercent, matchedReferenceId },
      'janitor upload: scene match ok'
    );
  }

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
      batch_id: batch_id ?? null,
    });
  } catch (err) {
    throw new AppError((err as Error).message, { stage: 'db-insert', cause: err });
  }

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
    batch_id: pending.batch_id ?? null,
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
    quality: qualityReport.metrics,
    scene_match_percent: sceneMatchPercent,
    matched_reference_id: matchedReferenceId,
  };
}

// ─── Result lookup ──────────────────────────────────────────────────────

function mapVerificationRow(row: Awaited<ReturnType<typeof verificationRepo.getLatestByTaskId>>) {
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
    scene_match_percent: row.scene_match_percent,
    cleanliness_percent: row.cleanliness_percent,
    overall_percent: row.overall_percent,
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

export async function getTaskVerificationResult(task_id: number) {
  const row = await verificationRepo.getLatestByTaskId(task_id);
  return mapVerificationRow(row);
}

export async function getTaskVerificationHistory(task_id: number) {
  const rows = await verificationRepo.getAllByTaskId(task_id);
  return rows.map((row) => ({
    verification_id: row.id,
    status: row.status,
    similarity_score: row.similarity_score,
    scene_match_percent: row.scene_match_percent,
    cleanliness_percent: row.cleanliness_percent,
    overall_percent: row.overall_percent,
    vision: {
      passed: row.vision_passed,
      score: row.vision_score,
      confidence: row.vision_confidence,
      issues: row.vision_issues ?? [],
    },
    rule_reason: row.rule_reason,
    created_at: row.created_at,
    processed_at: row.processed_at,
  }));
}

export async function getBatchVerificationStatus(batch_id: string) {
  const rows = await verificationRepo.getByBatchId(batch_id);
  const total = rows.length;
  let pending = 0;
  let processing = 0;
  let pass = 0;
  let fail = 0;
  let manual_review = 0;
  let error = 0;

  for (const row of rows) {
    if (row.status === 'PENDING') pending++;
    else if (row.status === 'PROCESSING') processing++;
    else if (row.status === 'PASS') pass++;
    else if (row.status === 'FAIL' || row.status === 'INVALID_TASK') fail++;
    else if (row.status === 'MANUAL_REVIEW') manual_review++;
    else if (row.status === 'ERROR') error++;
  }

  return {
    batch_id,
    summary: {
      total,
      pending,
      processing,
      pass,
      fail,
      manual_review,
      error,
      completed: pass + fail + manual_review + error,
    },
    results: rows.map(mapVerificationRow),
  };
}

