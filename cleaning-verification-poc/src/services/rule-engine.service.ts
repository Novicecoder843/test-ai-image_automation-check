import { env } from '../config/env.js';
import type { VisionResult } from './vision.service.js';

/**
 * Rule Engine v2 — percentage-based PASS / FAIL / MANUAL_REVIEW / INVALID_TASK
 *
 *   INVALID_TASK:  scene similarity below SCENE_MATCH_MIN (wrong area)
 *   PASS:           scene ok + similarity ≥ pass + cleanliness ≥ 80 + vision.passed
 *   FAIL:           scene ok + (cleanliness < 50 OR low score + stain-type issues)
 *   MANUAL_REVIEW:  everything else in the gray zone
 */

export type CleaningDecision = 'PASS' | 'FAIL' | 'MANUAL_REVIEW' | 'INVALID_TASK';

export interface RuleInput {
  similarity: number;
  vision: VisionResult;
  /** When false, decision is INVALID_TASK regardless of vision. Default true. */
  sceneMatchOk?: boolean;
}

export interface ScoringResult {
  decision: CleaningDecision;
  reason: string;
  scene_match_percent: number;
  cleanliness_percent: number | null;
  overall_percent: number | null;
  thresholds: {
    similarity_pass: number;
    similarity_fail: number;
    scene_match_min: number;
    vision_pass_score: number;
    vision_fail_score: number;
    vision_review_score: number;
  };
}

const DEFECT_KEYWORDS = [
  'stain',
  'spill',
  'floor',
  'dirt',
  'trash',
  'wet',
  'grime',
  'grout',
  'mud',
  'filth',
  'debris',
];

export function computeOverallPercent(
  sceneMatchPercent: number,
  cleanlinessPercent: number
): number {
  const sceneW = env.CLEANING_SCENE_WEIGHT;
  const cleanW = env.CLEANING_CLEANLINESS_WEIGHT;
  return Number((sceneW * sceneMatchPercent + cleanW * cleanlinessPercent).toFixed(1));
}

export function hasCleanlinessDefectIssues(issues: string[]): boolean {
  if (!issues?.length) return false;
  const joined = issues.join(' ').toLowerCase();
  return DEFECT_KEYWORDS.some((kw) => joined.includes(kw));
}

function hasVisionUnavailableIssue(issues: string[]): boolean {
  return issues.some((issue) => {
    const normalized = issue.toLowerCase();
    return (
      normalized.startsWith('vision_error:') ||
      normalized === 'no_vision_response'
    );
  });
}

function buildThresholds() {
  return {
    similarity_pass: env.CLEANING_SIMILARITY_PASS_THRESHOLD,
    similarity_fail: env.CLEANING_SIMILARITY_FAIL_THRESHOLD,
    scene_match_min: env.SCENE_MATCH_MIN_SIMILARITY,
    vision_pass_score: env.CLEANING_VISION_PASS_SCORE,
    vision_fail_score: env.CLEANING_VISION_FAIL_SCORE,
    vision_review_score: env.CLEANING_VISION_REVIEW_SCORE,
  };
}

export function evaluateRules(input: RuleInput): ScoringResult {
  const { similarity, vision } = input;
  const sceneMatchOk = input.sceneMatchOk !== false;
  const thresholds = buildThresholds();

  const sceneMatchPercent = Number((similarity * 100).toFixed(1));
  const cleanlinessPercent =
    vision?.score != null && Number.isFinite(vision.score) ? vision.score : null;

  const overallPercent =
    cleanlinessPercent != null
      ? computeOverallPercent(sceneMatchPercent, cleanlinessPercent)
      : null;

  // Wrong area / wrong task
  if (!sceneMatchOk || (env.SCENE_MATCH_ENFORCE && similarity < thresholds.scene_match_min)) {
    return {
      decision: 'INVALID_TASK',
      reason: `scene match ${sceneMatchPercent}% < required ${(thresholds.scene_match_min * 100).toFixed(0)}% — wrong task area`,
      scene_match_percent: sceneMatchPercent,
      cleanliness_percent: cleanlinessPercent,
      overall_percent: overallPercent,
      thresholds,
    };
  }

  if (!Number.isFinite(similarity)) {
    return {
      decision: 'MANUAL_REVIEW',
      reason: 'similarity_unavailable',
      scene_match_percent: sceneMatchPercent,
      cleanliness_percent: cleanlinessPercent,
      overall_percent: overallPercent,
      thresholds,
    };
  }

  // Legacy low-similarity fail (when scene enforce is off)
  if (!env.SCENE_MATCH_ENFORCE && similarity < thresholds.similarity_fail) {
    return {
      decision: 'FAIL',
      reason: `similarity ${similarity.toFixed(3)} < fail_threshold ${thresholds.similarity_fail}`,
      scene_match_percent: sceneMatchPercent,
      cleanliness_percent: cleanlinessPercent,
      overall_percent: overallPercent,
      thresholds,
    };
  }

  const issues = vision?.issues ?? [];
  const visionPassed = vision?.passed === true;
  const score = cleanlinessPercent;

  if (score == null || hasVisionUnavailableIssue(issues)) {
    return {
      decision: 'MANUAL_REVIEW',
      reason: [
        `scene match ${sceneMatchPercent}%`,
        'cleanliness unavailable',
        hasVisionUnavailableIssue(issues) ? 'vision provider unavailable' : 'vision score unavailable',
      ].join('; '),
      scene_match_percent: sceneMatchPercent,
      cleanliness_percent: cleanlinessPercent,
      overall_percent: overallPercent,
      thresholds,
    };
  }

  // FAIL — clearly not clean enough
  if (
    score < thresholds.vision_fail_score ||
    (score < thresholds.vision_review_score && hasCleanlinessDefectIssues(issues))
  ) {
    const defectNote = hasCleanlinessDefectIssues(issues)
      ? '; visible defects in issues list'
      : '';
    return {
      decision: 'FAIL',
      reason: `cleanliness ${score}% < fail_threshold ${thresholds.vision_fail_score}%${defectNote}; scene match ${sceneMatchPercent}% confirms correct area`,
      scene_match_percent: sceneMatchPercent,
      cleanliness_percent: cleanlinessPercent,
      overall_percent: overallPercent,
      thresholds,
    };
  }

  // PASS — both scene and cleanliness strong
  if (
    similarity >= thresholds.similarity_pass &&
    score >= thresholds.vision_pass_score &&
    visionPassed
  ) {
    return {
      decision: 'PASS',
      reason: `scene match ${sceneMatchPercent}%, cleanliness ${score}%, overall ${overallPercent}% — meets pass thresholds`,
      scene_match_percent: sceneMatchPercent,
      cleanliness_percent: cleanlinessPercent,
      overall_percent: overallPercent,
      thresholds,
    };
  }

  // MANUAL_REVIEW — gray zone
  const inSimilarityGray =
    similarity >= thresholds.similarity_fail && similarity <= thresholds.similarity_pass;

  return {
    decision: 'MANUAL_REVIEW',
    reason: [
      `scene match ${sceneMatchPercent}%`,
      `cleanliness ${score}%`,
      `overall ${overallPercent}%`,
      inSimilarityGray ? 'similarity in review band' : null,
      !visionPassed ? `vision not pass (confidence=${vision?.confidence})` : null,
      score < thresholds.vision_pass_score ? `below pass score ${thresholds.vision_pass_score}` : null,
    ]
      .filter(Boolean)
      .join('; '),
    scene_match_percent: sceneMatchPercent,
    cleanliness_percent: cleanlinessPercent,
    overall_percent: overallPercent,
    thresholds,
  };
}

