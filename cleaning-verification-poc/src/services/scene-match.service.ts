import { env } from '../config/env.js';
import { AppError } from '../middlewares/error-handler.js';
import { findBestMatch } from './similarity.service.js';
import type { CleaningReferenceRow } from '../repositories/cleaning-reference.repo.js';

/**
 * Scene / task matching — ensures the janitor photographed the correct area
 * (e.g. corridor task → corridor photo, not kitchen).
 *
 * Uses CLIP cosine similarity against template-scoped reference embeddings.
 * Checked synchronously at janitor upload AND again in the worker.
 */

export interface SceneMatchResult {
  ok: boolean;
  similarity: number;
  referenceId: number;
  reference: CleaningReferenceRow;
}

export function assessSceneMatch(
  uploadedEmbedding: number[],
  references: CleaningReferenceRow[]
): SceneMatchResult | null {
  if (!references.length) return null;

  const best = findBestMatch(uploadedEmbedding, references);
  if (!best) return null;

  const similarity = Math.max(-1, Math.min(1, best.score));
  const minSimilarity = env.SCENE_MATCH_MIN_SIMILARITY;

  return {
    ok: !env.SCENE_MATCH_ENFORCE || similarity >= minSimilarity,
    similarity,
    referenceId: best.match.id,
    reference: best.match,
  };
}

export function enforceSceneMatch(
  result: SceneMatchResult | null,
  opts: { facility_id: number; template_id: number | null }
): asserts result is SceneMatchResult {
  if (!result) {
    throw new AppError('No reference image found for this task', {
      status: 400,
      stage: 'scene-match',
      details: {
        code: 'NO_REFERENCE_FOR_TASK',
        facility_id: opts.facility_id,
        template_id: opts.template_id,
        hint: 'An admin must upload a reference image for this facility and template_id first.',
      },
    });
  }

  if (result.ok) return;

  throw new AppError('Please upload a valid task image', {
    status: 422,
    stage: 'scene-match',
    details: {
      code: 'INVALID_TASK_IMAGE',
      similarity: Number(result.similarity.toFixed(4)),
      required_min: env.SCENE_MATCH_MIN_SIMILARITY,
      matched_reference_id: result.referenceId,
      template_id: opts.template_id,
      hint: 'Photograph the same area as the task reference (e.g. corridor, not kitchen).',
    },
  });
}
