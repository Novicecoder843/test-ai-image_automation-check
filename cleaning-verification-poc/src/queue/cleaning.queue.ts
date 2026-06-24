import { Queue, type Job } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { getBullMQConnection } from './redis.js';
import { logger } from '../config/logger.js';

export const CLEANING_QUEUE_NAME = 'cleaning-verification-queue';
export const CLEANING_JOB_TYPE = 'verify-cleaning';

/**
 * Job payload — minimal; the worker fetches reference rows from Postgres.
 */
export interface CleaningJobData {
  verification_id: number;
  task_id: number;
  facility_id: number;
  template_id: number | null;
  janitor_id: string | null;
  uploaded_image_path: string;
  uploaded_image_url: string;
  uploaded_image_mime: string;
  enqueued_at: number;
}

export const cleaningQueue = new Queue<CleaningJobData>(CLEANING_QUEUE_NAME, {
  connection: getBullMQConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 500 },
  },
});

cleaningQueue.on('error', (err) => logger.error({ err: err.message }, 'cleaning queue error'));

/**
 * Globally-unique BullMQ job id (avoids Redis-counter collisions across restarts).
 */
export function generateJobId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

export async function enqueueCleaningVerification(
  data: Omit<CleaningJobData, 'enqueued_at'>
): Promise<Job<CleaningJobData>> {
  const payload: CleaningJobData = { ...data, enqueued_at: Date.now() };
  const job = await cleaningQueue.add(CLEANING_JOB_TYPE, payload, {
    jobId: generateJobId('cleaning-verify'),
  });
  logger.info(
    { jobId: job.id, verificationId: data.verification_id, taskId: data.task_id },
    'cleaning verification enqueued'
  );
  return job;
}

export async function getCleaningQueueStats() {
  const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
    cleaningQueue.getWaitingCount(),
    cleaningQueue.getActiveCount(),
    cleaningQueue.getCompletedCount(),
    cleaningQueue.getFailedCount(),
    cleaningQueue.getDelayedCount(),
    cleaningQueue.isPaused(),
  ]);
  return { waiting, active, completed, failed, delayed, paused };
}

export async function closeQueue(): Promise<void> {
  await cleaningQueue.close().catch(() => {});
}
