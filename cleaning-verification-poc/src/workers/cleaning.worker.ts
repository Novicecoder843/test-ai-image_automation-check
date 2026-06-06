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
import { findBestMatch } from '../services/similarity.service.js';
import { analyzeCleanliness, type VisionResult } from '../services/vision.service.js';
import { evaluateRules } from '../services/rule-engine.service.js';

/**
 * Cleaning verification worker.
 *
 * Flow per job:
 *   1. mark PROCESSING
 *   2. generate CLIP embedding of the uploaded image
 *   3. fetch active references and pick the best match
 *   4. run GPT-4o Vision (with graceful fallback to MANUAL_REVIEW)
 *   5. evaluate rules → PASS / FAIL / MANUAL_REVIEW
 *   6. persist result
 */

let instance: Worker<CleaningJobData> | null = null;

export async function processCleaningJob(job: Job<CleaningJobData>): Promise<unknown> {
  const startedAt = Date.now();
  const { verification_id, task_id, facility_id, template_id, uploaded_image_url } = job.data;

  logger.info({ jobId: job.id, verificationId: verification_id, taskId: task_id }, 'job: start');

  try {
    await verificationRepo.markProcessing(verification_id);

    // 1) Embed uploaded image
    const uploadedEmbedding = await generateImageEmbeddingFromUrl(uploaded_image_url);
    logger.info(
      { verificationId: verification_id, dim: uploadedEmbedding.length },
      'job: embedded uploaded image'
    );

    // 2) Reference lookup + similarity
    const references = await referenceRepo.getActiveReferencesByFacility(
      facility_id,
      template_id ?? null
    );
    if (!references.length) {
      throw new Error(`No active reference image for facility ${facility_id}`);
    }
    const best = findBestMatch(uploadedEmbedding, references);
    if (!best) throw new Error('Could not compute similarity against references');
    const similarity = Math.max(-1, Math.min(1, best.score));
    const reference = best.match;
    logger.info(
      {
        verificationId: verification_id,
        referenceId: reference.id,
        similarity,
        candidates: references.length,
      },
      'job: best reference selected'
    );

    // 3) GPT-4o Vision (fallback on failure)
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
        score: 0,
        confidence: 0,
        issues: [`vision_error:${(err as Error).message}`],
        raw: null,
      };
    }

    // 4) Rule engine
    const rule = evaluateRules({ similarity, vision });
    let finalStatus = rule.decision;
    if (vision.raw == null && finalStatus === 'PASS') finalStatus = 'MANUAL_REVIEW';

    // 5) Persist
    const saved = await verificationRepo.saveResult(verification_id, {
      reference_id: reference.id,
      embedding: uploadedEmbedding,
      similarity_score: Number(similarity.toFixed(4)),
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
