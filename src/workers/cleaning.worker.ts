import { Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../queue/redis.js';
import {
  CLEANING_QUEUE_NAME,
  type CleaningJobData,
} from '../queue/cleaning.queue.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

import * as referenceRepo from '../repositories/cleaning-reference.repo.js';
import * as verificationRepo from '../repositories/cleaning-verification.repo.js';
import { generateImageEmbeddingFromUrl } from '../services/embedding.service.js';
import { assessSceneMatch } from '../services/scene-match.service.js';
import { analyzeCleanliness, type VisionResult } from '../services/vision.service.js';
import { evaluateRules } from '../services/rule-engine.service.js';

/**
 * Cleaning verification worker.
 *
 * Flow per job:
 *   1. mark PROCESSING
 *   2. generate CLIP embedding of the uploaded image
 *   3. fetch template-scoped references and pick the best match
 *   4. scene double-check → INVALID_TASK if wrong area (skip vision)
 *   5. run Vision LLM (with graceful fallback to MANUAL_REVIEW)
 *   6. evaluate rules v2 → PASS / FAIL / MANUAL_REVIEW + percentages
 *   7. persist result
 */

let instance: Worker<CleaningJobData> | null = null;

export async function processCleaningJob(job: Job<CleaningJobData>): Promise<unknown> {
  const startedAt = Date.now();
  const { verification_id, task_id, facility_id, template_id, uploaded_image_url } = job.data;

  logger.info({ jobId: job.id, verificationId: verification_id, taskId: task_id }, 'job: start');

  try {
    await verificationRepo.markProcessing(verification_id);

    const uploadedEmbedding = await generateImageEmbeddingFromUrl(uploaded_image_url);
    logger.info(
      { verificationId: verification_id, dim: uploadedEmbedding.length },
      'job: embedded uploaded image'
    );

    let similarity = 1.0;
    let reference = await referenceRepo.getReferenceById(task_id);
    let sceneOk = true;

    if (reference && reference.facility_id === facility_id) {
      logger.info(
        { verificationId: verification_id, referenceId: reference.id },
        'job: using explicit reference selected by user'
      );
      // We can still optionally calculate similarity for the rules
      const refEmbedding = reference.embedding;
      let dot = 0;
      for (let i = 0; i < uploadedEmbedding.length; i++) {
        dot += uploadedEmbedding[i] * refEmbedding[i];
      }
      similarity = dot; // Assuming normalized
    } else {
      const references = await referenceRepo.getReferencesForSceneMatch(
        facility_id,
        template_id ?? null
      );
      if (!references.length) {
        throw new Error(`No active reference image for facility ${facility_id} template ${template_id}`);
      }

      const sceneResult = assessSceneMatch(uploadedEmbedding, references);
      if (!sceneResult) {
        throw new Error('Could not compute similarity against references');
      }

      similarity = sceneResult.similarity;
      reference = sceneResult.reference;
      sceneOk = sceneResult.ok;

      logger.info(
        {
          verificationId: verification_id,
          referenceId: reference.id,
          similarity,
          sceneOk,
          candidates: references.length,
        },
        'job: best reference selected via auto-match'
      );
    }

    // Scene double-check — skip expensive vision on wrong-area photos
    if (!sceneOk) {
      const rule = evaluateRules({
        similarity,
        vision: { passed: false, score: 0, confidence: 0, issues: ['wrong_task_area'] },
        sceneMatchOk: false,
      });

      const saved = await verificationRepo.saveResult(verification_id, {
        reference_id: reference.id,
        embedding: uploadedEmbedding,
        similarity_score: Number(similarity.toFixed(4)),
        scene_match_percent: rule.scene_match_percent,
        cleanliness_percent: rule.cleanliness_percent,
        overall_percent: rule.overall_percent,
        status: 'INVALID_TASK',
        rule_reason: rule.reason,
        error_message: 'Please upload a valid task image for this template',
      });

      logger.warn(
        { verificationId: verification_id, similarity, status: saved.status },
        'job: INVALID_TASK — wrong area'
      );

      return {
        verification_id,
        task_id,
        status: saved.status,
        similarity,
        scene_match_percent: rule.scene_match_percent,
        durationMs: Date.now() - startedAt,
      };
    }

    let vision: VisionResult;
    try {
      vision = await analyzeCleanliness(reference.image_url ?? uploaded_image_url, uploaded_image_url);
    } catch (err) {
      logger.error(
        { verificationId: verification_id, err: (err as Error).message },
        'job: vision failed → MANUAL_REVIEW'
      );
      vision = {
        passed: false,
        score: null,
        confidence: 0,
        issues: [`vision_error:${(err as Error).message}`],
        raw: null,
      };
    }

    const rule = evaluateRules({ similarity, vision, sceneMatchOk: true });
    let finalStatus = rule.decision;
    if (vision.raw == null && finalStatus === 'PASS') finalStatus = 'MANUAL_REVIEW';

    const saved = await verificationRepo.saveResult(verification_id, {
      reference_id: reference.id,
      embedding: uploadedEmbedding,
      similarity_score: Number(similarity.toFixed(4)),
      scene_match_percent: rule.scene_match_percent,
      cleanliness_percent: rule.cleanliness_percent,
      overall_percent: rule.overall_percent,
      vision_passed: vision.passed,
      vision_score: vision.score,
      vision_confidence: vision.confidence,
      vision_issues: vision.issues,
      vision_raw: vision.raw ?? null,
      status: finalStatus,
      rule_reason: rule.reason,
    });

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        jobId: job.id,
        verificationId: verification_id,
        status: saved.status,
        similarity,
        scene_match_percent: rule.scene_match_percent,
        cleanliness_percent: rule.cleanliness_percent,
        overall_percent: rule.overall_percent,
        visionScore: vision.score,
        durationMs,
      },
      'job: complete'
    );

    return {
      verification_id,
      task_id,
      status: saved.status,
      similarity,
      scene_match_percent: rule.scene_match_percent,
      cleanliness_percent: rule.cleanliness_percent,
      overall_percent: rule.overall_percent,
      visionScore: vision.score,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      {
        jobId: job.id,
        verificationId: verification_id,
        attemptsMade: job.attemptsMade,
        err: (err as Error).message,
        stack: (err as Error).stack,
        durationMs,
      },
      'job: failed'
    );
    try {
      await verificationRepo.saveResult(verification_id, {
        status: 'ERROR',
        rule_reason: 'worker_error',
        error_message: (err as Error).message,
      });
    } catch (persistErr) {
      logger.error({ verificationId: verification_id, err: (persistErr as Error).message }, 'failed to persist ERROR');
    }
    throw err;
  }
}

export function startCleaningWorker(): Worker<CleaningJobData> {
  if (instance) {
    logger.warn('cleaning worker already started');
    return instance;
  }
  const worker = new Worker<CleaningJobData>(
    CLEANING_QUEUE_NAME,
    async (job) => processCleaningJob(job),
    {
      connection: getBullMQConnection(),
      concurrency: env.WORKER_CONCURRENCY,
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 500 },
    }
  );

  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'worker: completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'worker: failed')
  );
  worker.on('error', (err) => logger.error({ err: err.message }, 'worker: error'));
  worker.on('stalled', (jobId) => logger.warn({ jobId }, 'worker: stalled'));
  worker.on('active', (job) => logger.info({ jobId: job.id }, 'worker: active'));

  instance = worker;
  logger.info({ queue: CLEANING_QUEUE_NAME, concurrency: env.WORKER_CONCURRENCY }, 'cleaning worker started');
  return worker;
}

export async function stopCleaningWorker(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
  logger.info('cleaning worker stopped');
}
