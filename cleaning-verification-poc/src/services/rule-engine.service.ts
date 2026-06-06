import { env } from '../config/env.js';
import type { VisionResult } from './vision.service.js';

/**
 * Rule Engine
 *
 *   PASS:           similarity > PASS_THRESHOLD  AND vision.passed === true
 *   FAIL:           similarity < FAIL_THRESHOLD
 *   MANUAL_REVIEW:  everything else
 */

export type CleaningDecision = 'PASS' | 'FAIL' | 'MANUAL_REVIEW';

export interface RuleInput {
  similarity: number;     // 0..1 cosine
  vision: VisionResult;
}

export interface RuleResult {
  decision: CleaningDecision;
  reason: string;
  thresholds: { pass: number; fail: number };
}

export function evaluateRules({ similarity, vision }: RuleInput): RuleResult {
  const thresholds = {
    pass: env.CLEANING_SIMILARITY_PASS_THRESHOLD,
    fail: env.CLEANING_SIMILARITY_FAIL_THRESHOLD,
  };

  if (!Number.isFinite(similarity)) {
    return { decision: 'MANUAL_REVIEW', reason: 'similarity_unavailable', thresholds };
  }

  if (similarity < thresholds.fail) {
    return {
      decision: 'FAIL',
      reason: `similarity ${similarity.toFixed(3)} < fail_threshold ${thresholds.fail}`,
      thresholds,
    };
  }

  if (similarity > thresholds.pass && vision?.passed === true) {
    return {
      decision: 'PASS',
      reason: `similarity ${similarity.toFixed(3)} > pass_threshold ${thresholds.pass} and vision passed`,
      thresholds,
    };
  }

  return {
    decision: 'MANUAL_REVIEW',
    reason: `similarity ${similarity.toFixed(3)} in [${thresholds.fail}, ${thresholds.pass}] or vision verdict not pass (passed=${vision?.passed}, confidence=${vision?.confidence})`,
    thresholds,
  };
}
