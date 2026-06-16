import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import {
  toPgVectorLiteral,
  parsePgVectorLiteral,
} from '../services/embedding.service.js';

export interface CleaningReferenceRow {
  id: number;
  facility_id: number;
  template_id: number | null;
  label: string | null;
  image_path: string;
  image_url: string | null;
  image_mime: string | null;
  image_width: number | null;
  image_height: number | null;
  image_bytes: number | null;
  embedding: number[];
  uploaded_by: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const TABLE = 'cleaning_references';
const COLS =
  'id, facility_id, template_id, label, image_path, image_url, image_mime, ' +
  'image_width, image_height, image_bytes, uploaded_by, is_active, created_at, updated_at';

export interface InsertReferenceParams {
  facility_id: number;
  template_id?: number | null;
  label?: string | null;
  image_path: string;
  image_url?: string | null;
  image_mime?: string | null;
  image_width?: number | null;
  image_height?: number | null;
  image_bytes?: number | null;
  embedding: number[];
  uploaded_by?: string | null;
}

export async function insertReference(
  params: InsertReferenceParams
): Promise<Omit<CleaningReferenceRow, 'embedding'>> {
  const sql = `
    INSERT INTO ${TABLE}
      (facility_id, template_id, label, image_path, image_url, image_mime,
       image_width, image_height, image_bytes, embedding, uploaded_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11)
    RETURNING ${COLS}`;
  const values = [
    params.facility_id,
    params.template_id ?? null,
    params.label ?? null,
    params.image_path,
    params.image_url ?? null,
    params.image_mime ?? null,
    params.image_width ?? null,
    params.image_height ?? null,
    params.image_bytes ?? null,
    toPgVectorLiteral(params.embedding),
    params.uploaded_by ?? null,
  ];
  const result = await query<Omit<CleaningReferenceRow, 'embedding'>>(sql, values);
  return result.rows[0]!;
}

export async function getActiveReferencesByFacility(
  facility_id: number,
  template_id?: number | null
): Promise<CleaningReferenceRow[]> {
  const params: unknown[] = [facility_id];
  let where = 'WHERE facility_id = $1 AND is_active = TRUE';
  if (template_id != null) {
    params.push(template_id);
    where += ` AND (template_id = $${params.length} OR template_id IS NULL)`;
  }
  const sql = `
    SELECT id, facility_id, template_id, label, image_path, image_url,
           image_mime, image_width, image_height, image_bytes,
           embedding::text AS embedding, uploaded_by, is_active,
           created_at, updated_at
    FROM ${TABLE}
    ${where}
    ORDER BY (template_id IS NULL) ASC, created_at DESC`;
  const result = await query<CleaningReferenceRow & { embedding: string }>(sql, params);
  return result.rows.map((row) => ({
    ...row,
    embedding: parsePgVectorLiteral(row.embedding),
  })) as CleaningReferenceRow[];
}

/**
 * Active references scoped to an exact template_id (no NULL fallback).
 * Used when SCENE_MATCH_STRICT_TEMPLATE=true.
 */
export async function getActiveReferencesByTemplate(
  facility_id: number,
  template_id: number
): Promise<CleaningReferenceRow[]> {
  const sql = `
    SELECT id, facility_id, template_id, label, image_path, image_url,
           image_mime, image_width, image_height, image_bytes,
           embedding::text AS embedding, uploaded_by, is_active,
           created_at, updated_at
    FROM ${TABLE}
    WHERE facility_id = $1 AND template_id = $2 AND is_active = TRUE
    ORDER BY created_at DESC`;
  const result = await query<CleaningReferenceRow & { embedding: string }>(sql, [
    facility_id,
    template_id,
  ]);
  return result.rows.map((row) => ({
    ...row,
    embedding: parsePgVectorLiteral(row.embedding),
  })) as CleaningReferenceRow[];
}

/**
 * Load references for scene matching — strict or legacy (includes NULL template).
 */
export async function getReferencesForSceneMatch(
  facility_id: number,
  template_id: number | null
): Promise<CleaningReferenceRow[]> {
  if (template_id != null && env.SCENE_MATCH_STRICT_TEMPLATE) {
    return getActiveReferencesByTemplate(facility_id, template_id);
  }
  return getActiveReferencesByFacility(facility_id, template_id);
}

/**
 * pgvector ANN best match (cosine). Returns null when no active references.
 */
export async function findBestMatchByVector(
  facility_id: number,
  embedding: number[],
  template_id?: number | null
): Promise<(CleaningReferenceRow & { similarity: number }) | null> {
  const params: unknown[] = [toPgVectorLiteral(embedding), facility_id];
  let where = 'WHERE facility_id = $2 AND is_active = TRUE';
  if (template_id != null) {
    params.push(template_id);
    where += ` AND (template_id = $${params.length} OR template_id IS NULL)`;
  }
  const sql = `
    SELECT id, facility_id, template_id, label, image_path, image_url,
           image_mime, image_width, image_height, image_bytes,
           embedding::text AS embedding, uploaded_by, is_active,
           created_at, updated_at,
           1 - (embedding <=> $1::vector) AS similarity
    FROM ${TABLE}
    ${where}
    ORDER BY embedding <=> $1::vector
    LIMIT 1`;
  const result = await query<
    CleaningReferenceRow & { embedding: string; similarity: string }
  >(sql, params);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    embedding: parsePgVectorLiteral(row.embedding),
    similarity: Number(row.similarity),
  } as CleaningReferenceRow & { similarity: number };
}
