import { query } from '../db/pool.js';
import {
  toPgVectorLiteral,
  parsePgVectorLiteral,
} from '../services/embedding.service.js';

export type CleaningVerificationStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PASS'
  | 'FAIL'
  | 'MANUAL_REVIEW'
  | 'ERROR'
  | 'INVALID_TASK';

export interface CleaningVerificationRow {
  id: number;
  task_id: number;
  facility_id: number;
  template_id: number | null;
  reference_id: number | null;
  janitor_id: string | null;
  image_path: string;
  image_url: string | null;
  image_mime: string | null;
  image_width: number | null;
  image_height: number | null;
  image_bytes: number | null;
  embedding: number[] | null;
  similarity_score: number | null;
  scene_match_percent: number | null;
  cleanliness_percent: number | null;
  overall_percent: number | null;
  vision_passed: boolean | null;
  vision_score: number | null;
  vision_confidence: number | null;
  vision_issues: unknown[] | null;
  vision_raw: unknown | null;
  status: CleaningVerificationStatus;
  rule_reason: string | null;
  bull_job_id: string | null;
  error_message: string | null;
  created_at: Date;
  processed_at: Date | null;
  updated_at: Date;
  batch_id: string | null;
}

const TABLE = 'cleaning_verifications';

function hydrate(row: Record<string, unknown>): CleaningVerificationRow {
  const r = row as Record<string, unknown> & { embedding?: string };
  return {
    id: Number(r.id),
    task_id: Number(r.task_id),
    facility_id: Number(r.facility_id),
    template_id: r.template_id != null ? Number(r.template_id) : null,
    janitor_id: r.janitor_id != null ? String(r.janitor_id) : null,
    reference_id: r.reference_id != null ? Number(r.reference_id) : null,
    image_path: String(r.image_path),
    image_url: r.image_url != null ? String(r.image_url) : null,
    image_mime: r.image_mime != null ? String(r.image_mime) : null,
    image_width: r.image_width != null ? Number(r.image_width) : null,
    image_height: r.image_height != null ? Number(r.image_height) : null,
    image_bytes: r.image_bytes != null ? Number(r.image_bytes) : null,
    embedding: r.embedding ? parsePgVectorLiteral(r.embedding) : null,
    similarity_score: r.similarity_score != null ? Number(r.similarity_score) : null,
    scene_match_percent: r.scene_match_percent != null ? Number(r.scene_match_percent) : null,
    cleanliness_percent: r.cleanliness_percent != null ? Number(r.cleanliness_percent) : null,
    overall_percent: r.overall_percent != null ? Number(r.overall_percent) : null,
    vision_passed: r.vision_passed != null ? Boolean(r.vision_passed) : null,
    vision_score: r.vision_score != null ? Number(r.vision_score) : null,
    vision_confidence: r.vision_confidence != null ? Number(r.vision_confidence) : null,
    vision_issues: r.vision_issues != null ? (r.vision_issues as unknown[]) : null,
    vision_raw: r.vision_raw != null ? r.vision_raw : null,
    status: r.status as CleaningVerificationStatus,
    rule_reason: r.rule_reason != null ? String(r.rule_reason) : null,
    bull_job_id: r.bull_job_id != null ? String(r.bull_job_id) : null,
    error_message: r.error_message != null ? String(r.error_message) : null,
    created_at: r.created_at as Date,
    processed_at: r.processed_at != null ? (r.processed_at as Date) : null,
    updated_at: r.updated_at as Date,
    batch_id: r.batch_id != null ? String(r.batch_id) : null,
  };
}

export async function createPending(params: {
  task_id: number;
  facility_id: number;
  template_id?: number | null;
  janitor_id?: string | null;
  image_path: string;
  image_url?: string | null;
  image_mime?: string | null;
  image_width?: number | null;
  image_height?: number | null;
  image_bytes?: number | null;
  batch_id?: string | null;
}): Promise<CleaningVerificationRow> {
  const sql = `
    INSERT INTO ${TABLE}
      (task_id, facility_id, template_id, janitor_id,
       image_path, image_url, image_mime, image_width, image_height, image_bytes, status, batch_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11)
    RETURNING *, embedding::text AS embedding`;
  const values = [
    params.task_id,
    params.facility_id,
    params.template_id ?? null,
    params.janitor_id ?? null,
    params.image_path,
    params.image_url ?? null,
    params.image_mime ?? null,
    params.image_width ?? null,
    params.image_height ?? null,
    params.image_bytes ?? null,
    params.batch_id ?? null,
  ];
  const result = await query<Record<string, unknown>>(sql, values);
  return hydrate(result.rows[0]!);
}

export async function attachJobId(id: number, bullJobId: string): Promise<void> {
  await query(
    `UPDATE ${TABLE} SET bull_job_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, bullJobId]
  );
}

export async function markProcessing(id: number): Promise<void> {
  await query(
    `UPDATE ${TABLE} SET status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id]
  );
}

export interface SaveResultParams {
  reference_id?: number | null;
  embedding?: number[] | null;
  similarity_score?: number | null;
  scene_match_percent?: number | null;
  cleanliness_percent?: number | null;
  overall_percent?: number | null;
  vision_passed?: boolean | null;
  vision_score?: number | null;
  vision_confidence?: number | null;
  vision_issues?: unknown[] | null;
  vision_raw?: unknown | null;
  status: CleaningVerificationStatus;
  rule_reason?: string | null;
  error_message?: string | null;
}

export async function saveResult(
  id: number,
  params: SaveResultParams
): Promise<CleaningVerificationRow> {
  const sql = `
    UPDATE ${TABLE} SET
      reference_id          = COALESCE($2, reference_id),
      embedding             = COALESCE($3::vector, embedding),
      similarity_score      = $4,
      scene_match_percent   = $5,
      cleanliness_percent   = $6,
      overall_percent       = $7,
      vision_passed         = $8,
      vision_score          = $9,
      vision_confidence     = $10,
      vision_issues         = $11::jsonb,
      vision_raw            = $12::jsonb,
      status                = $13,
      rule_reason           = $14,
      error_message         = $15,
      processed_at          = CURRENT_TIMESTAMP,
      updated_at            = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *, embedding::text AS embedding`;
  const values = [
    id,
    params.reference_id ?? null,
    params.embedding ? toPgVectorLiteral(params.embedding) : null,
    params.similarity_score ?? null,
    params.scene_match_percent ?? null,
    params.cleanliness_percent ?? null,
    params.overall_percent ?? null,
    params.vision_passed ?? null,
    params.vision_score ?? null,
    params.vision_confidence ?? null,
    params.vision_issues ? JSON.stringify(params.vision_issues) : null,
    params.vision_raw ? JSON.stringify(params.vision_raw) : null,
    params.status,
    params.rule_reason ?? null,
    params.error_message ?? null,
  ];
  const result = await query<Record<string, unknown>>(sql, values);
  return hydrate(result.rows[0]!);
}

export async function getById(id: number): Promise<CleaningVerificationRow | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT *, embedding::text AS embedding FROM ${TABLE} WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? hydrate(result.rows[0]) : null;
}

export async function getLatestByTaskId(
  task_id: number
): Promise<CleaningVerificationRow | null> {
  const result = await query<Record<string, unknown>>(
    `SELECT *, embedding::text AS embedding FROM ${TABLE}
     WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [task_id]
  );
  return result.rows[0] ? hydrate(result.rows[0]) : null;
}

export async function getAllByTaskId(task_id: number): Promise<CleaningVerificationRow[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT *, embedding::text AS embedding FROM ${TABLE}
     WHERE task_id = $1 ORDER BY created_at DESC`,
    [task_id]
  );
  return result.rows.map(hydrate);
}

export async function getByBatchId(batch_id: string): Promise<CleaningVerificationRow[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT *, embedding::text AS embedding FROM ${TABLE}
     WHERE batch_id = $1 ORDER BY created_at ASC`,
    [batch_id]
  );
  return result.rows.map(hydrate);
}

