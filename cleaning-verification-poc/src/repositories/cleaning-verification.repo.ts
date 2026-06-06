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
  | 'ERROR';

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
}

const TABLE = 'cleaning_verifications';

function hydrate(row: Record<string, unknown>): CleaningVerificationRow {
  const r = row as Record<string, unknown> & { embedding?: string };
  return {
    ...(row as unknown as CleaningVerificationRow),
    embedding: r.embedding ? parsePgVectorLiteral(r.embedding) : null,
    similarity_score:
      r['similarity_score'] != null ? Number(r['similarity_score'] as number) : null,
    vision_score: r['vision_score'] != null ? Number(r['vision_score'] as number) : null,
    vision_confidence:
      r['vision_confidence'] != null ? Number(r['vision_confidence'] as number) : null,
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
}): Promise<CleaningVerificationRow> {
  const sql = `
    INSERT INTO ${TABLE}
      (task_id, facility_id, template_id, janitor_id,
       image_path, image_url, image_mime, image_width, image_height, image_bytes, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING')
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
      reference_id      = COALESCE($2, reference_id),
      embedding         = COALESCE($3::vector, embedding),
      similarity_score  = $4,
      vision_passed     = $5,
      vision_score      = $6,
      vision_confidence = $7,
      vision_issues     = $8::jsonb,
      vision_raw        = $9::jsonb,
      status            = $10,
      rule_reason       = $11,
      error_message     = $12,
      processed_at      = CURRENT_TIMESTAMP,
      updated_at        = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING *, embedding::text AS embedding`;
  const values = [
    id,
    params.reference_id ?? null,
    params.embedding ? toPgVectorLiteral(params.embedding) : null,
    params.similarity_score ?? null,
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
